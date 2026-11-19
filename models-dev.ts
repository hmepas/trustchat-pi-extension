/**
 * models.dev catalog support for the TrustChat pi extension.
 *
 * The module is side-effect free on import: no network request and no
 * filesystem access happen until `CatalogSource.load()` is called.
 *
 * The default source is https://models.dev/models.json — a flat map of
 * canonical `<vendor>/<model>` ids to model records. The name, input
 * modalities, limits and the `reasoning` flag are mapped into provider models.
 * `cost` is deliberately dropped: TrustChat bills differently.
 *
 * TrustChat exposes a few model ids that models.dev knows under a different
 * basename. `CATALOG_ALIASES` fills that gap: aliases are applied only when the
 * direct id/family lookup fails, so catalog data always wins over a rule.
 */

import { randomBytes } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const DEFAULT_CATALOG_URL = "https://models.dev/models.json"

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const MIN_REFRESH_INTERVAL_MS = 10 * 60 * 1000
const CACHE_SUBPATH = ["pi", "trustchat", "models.json"]

/** Errors Windows returns when a rename would replace an existing file. */
const REPLACE_RETRY_CODES = new Set(["EEXIST", "EPERM", "EACCES", "EBUSY", "ENOTEMPTY"])

export interface CatalogModelLimit {
  context?: number
  output?: number
}

export interface CatalogModalities {
  input?: string[]
}

export interface CatalogModel {
  /**
   * Canonical id, always `<vendor>/<model>`. For the flat models.json the map
   * key is canonical, so it is used even when the record repeats it.
   */
  id: string
  name?: string
  family?: string
  release_date?: string
  last_updated?: string
  /** True for models that expose reasoning/thinking levels. */
  reasoning?: boolean
  modalities?: CatalogModalities
  limit?: CatalogModelLimit
}

export interface Catalog {
  /** Canonical model id → record. Flat, no provider nesting. */
  models: Record<string, CatalogModel>
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== "string") continue
    const trimmed = item.trim()
    if (trimmed && !result.includes(trimmed)) result.push(trimmed)
  }
  return result.length > 0 ? result : undefined
}

/** Rejects arbitrary junk without touching known fields. */
function looksLikeModel(raw: Record<string, unknown>): boolean {
  return (
    typeof raw.id === "string" ||
    typeof raw.name === "string" ||
    typeof raw.family === "string" ||
    typeof raw.release_date === "string" ||
    isRecord(raw.modalities) ||
    isRecord(raw.limit)
  )
}

/**
 * A models.json key is always a canonical `<vendor>/<model>` id. Requiring the
 * vendor segment keeps payloads nested per provider out of the catalog.
 */
function isCanonicalID(key: string): boolean {
  const slash = key.indexOf("/")
  return slash > 0 && slash < key.length - 1
}

function normalizeModel(canonicalID: string, raw: unknown): CatalogModel | undefined {
  if (!isRecord(raw)) return undefined
  if (!looksLikeModel(raw)) return undefined

  const model: CatalogModel = { id: canonicalID }

  const name = nonEmptyString(raw.name)
  if (name) model.name = name

  const family = nonEmptyString(raw.family)
  if (family) model.family = family

  const releaseDate = nonEmptyString(raw.release_date)
  if (releaseDate) model.release_date = releaseDate

  const lastUpdated = nonEmptyString(raw.last_updated)
  if (lastUpdated) model.last_updated = lastUpdated

  if (typeof raw.reasoning === "boolean") model.reasoning = raw.reasoning

  if (isRecord(raw.modalities)) {
    const input = stringList(raw.modalities.input)
    if (input) model.modalities = { input }
  }

  if (isRecord(raw.limit)) {
    const limit: CatalogModelLimit = {}
    const context = positiveNumber(raw.limit.context)
    const output = positiveNumber(raw.limit.output)
    if (context) limit.context = context
    if (output) limit.output = output
    if (limit.context || limit.output) model.limit = limit
  }

  return model
}

/**
 * Validates a raw models.json payload and flattens it into `id → model`.
 *
 * The only supported shape is the flat models.json map:
 * `{ "<vendor>/<model>": { id, name, ... } }`. Keys without a vendor segment
 * and payloads nested per provider are rejected as an invalid format.
 *
 * Unknown fields are ignored, malformed entries are skipped. Never throws.
 */
export function parseCatalog(raw: unknown): Catalog | undefined {
  if (!isRecord(raw)) return undefined

  const entries = Object.entries(raw)
  if (entries.length === 0) return undefined

  const models: Record<string, CatalogModel> = {}

  for (const [key, entry] of entries) {
    if (!isCanonicalID(key)) continue
    const model = normalizeModel(key, entry)
    if (model) models[key] = model
  }

  if (Object.keys(models).length === 0) return undefined
  return { models }
}

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

export type CatalogMatchSource = "id" | "family"

export type CatalogAliasKind = "exact" | "prefix" | "suffix"

/**
 * One entry of the built-in TrustChat → models.dev mapping.
 *
 * Not a stable public API: the table is exported for tests and diagnostics and
 * may change with an extension release. Aliases are consulted only after a direct
 * id/family match fails.
 */
export interface CatalogAliasRule {
  kind: CatalogAliasKind
  /** Lower-case basename (exact), basename prefix (prefix) or suffix (suffix). */
  from: string
  /** Catalog basename (exact) or replacement prefix (prefix). */
  to?: string
  /** Exact display name; wins over the catalog name. */
  name?: string
  /** Appended to the resolved display name, e.g. " highspeed" or " 256K". */
  nameSuffix?: string
  /** Limit overrides applied after the catalog limits. */
  limit?: CatalogModelLimit
}

/** Resolved alias information attached to a catalog match. */
export interface CatalogAliasInfo {
  kind: CatalogAliasKind
  from: string
  to?: string
  name?: string
  nameSuffix?: string
  limit?: CatalogModelLimit
  /** Suffix rules actually applied, left-to-right (combined modifiers). */
  via?: readonly string[]
}

/**
 * Built-in aliases for TrustChat model ids that differ from the models.dev
 * basename. Order in this array does not define priority: `resolveCatalogEntry`
 * applies direct id → direct family → exact → prefix → suffix.
 */
export const CATALOG_ALIASES: readonly CatalogAliasRule[] = [
  { kind: "exact", from: "glm-5.3-flashx", to: "glm-5.3-flash", name: "GLM 5.3 FlashX" },
  { kind: "exact", from: "kimi-for-coding", to: "kimi-k3.1-pro", name: "Kimi For Coding" },
  { kind: "prefix", from: "k3", to: "kimi-k3" },
  { kind: "suffix", from: "-highspeed", nameSuffix: " highspeed" },
  { kind: "suffix", from: "-256k", nameSuffix: " 256K", limit: { context: 262_144 } },
]

export interface CatalogMatch {
  /** Canonical catalog id (`<vendor>/<model>`). */
  id: string
  model: CatalogModel
  /** Which direct rule produced the match: id suffix or exact family. */
  source: CatalogMatchSource
  /** Number of catalog entries that matched before picking the newest one. */
  candidates: number
  /** Set only when the match came through `CATALOG_ALIASES`. */
  alias?: CatalogAliasInfo
}

/** Parses an ISO date (`YYYY-MM-DD` as UTC, timestamps as-is). */
export function parseCatalogDate(value: string | undefined): number {
  const text = nonEmptyString(value)
  if (!text) return 0

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec(text)
  if (iso) {
    const time = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
    return Number.isFinite(time) && time > 0 ? time : 0
  }

  const parsed = Date.parse(text)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function compareIDs(a: string, b: string): number {
  if (a === b) return 0
  // Plain code-unit comparison, independent of the host locale.
  return a < b ? -1 : 1
}

interface CatalogCandidate {
  id: string
  model: CatalogModel
}

/**
 * Newest first by `release_date`, then `last_updated`, then the
 * lexicographically smallest canonical id. Deterministic regardless of the
 * key order in the catalog file.
 */
function pickNewest(candidates: CatalogCandidate[]): CatalogCandidate {
  return [...candidates].sort((a, b) => {
    const released = parseCatalogDate(b.model.release_date) - parseCatalogDate(a.model.release_date)
    if (released !== 0) return released
    const updated = parseCatalogDate(b.model.last_updated) - parseCatalogDate(a.model.last_updated)
    if (updated !== 0) return updated
    return compareIDs(a.id, b.id)
  })[0]
}

/** Catalog id lookup only: canonical id equals the needle or ends with "/<needle>". */
function matchID(catalog: Catalog, needle: string): CatalogMatch | undefined {
  const byID: CatalogCandidate[] = []
  for (const [id, model] of Object.entries(catalog.models)) {
    const lower = id.toLowerCase()
    if (lower === needle || lower.endsWith(`/${needle}`)) byID.push({ id, model })
  }
  if (byID.length === 0) return undefined

  const best = pickNewest(byID)
  return { ...best, source: "id", candidates: byID.length }
}

/** Exact `family` equality with the needle. */
function matchFamily(catalog: Catalog, needle: string): CatalogMatch | undefined {
  const byFamily: CatalogCandidate[] = []
  for (const [id, model] of Object.entries(catalog.models)) {
    const family = model.family?.trim().toLowerCase()
    if (family && family === needle) byFamily.push({ id, model })
  }
  if (byFamily.length === 0) return undefined

  const best = pickNewest(byFamily)
  return { ...best, source: "family", candidates: byFamily.length }
}

/**
 * Direct catalog lookup: id suffix first, then exact `family` equality. This is
 * the original behavior and is also used to resolve an exact-alias target
 * (which is a basename, never a hard-coded `<vendor>/<model>` id).
 */
function matchDirect(catalog: Catalog, needle: string): CatalogMatch | undefined {
  return matchID(catalog, needle) ?? matchFamily(catalog, needle)
}

/** Combines one or more alias rules into the info stored on the match. */
function combineAliases(rules: readonly CatalogAliasRule[]): CatalogAliasInfo {
  const info: CatalogAliasInfo = {
    kind: rules[0].kind,
    from: rules.map((rule) => rule.from).join(""),
  }

  const to = rules.find((rule) => rule.to)?.to
  if (to) info.to = to

  const name = rules.find((rule) => rule.name)?.name
  if (name) info.name = name

  const nameSuffix = rules.map((rule) => rule.nameSuffix ?? "").join("")
  if (nameSuffix) info.nameSuffix = nameSuffix

  let limit: CatalogModelLimit | undefined
  for (const rule of rules) {
    if (rule.limit) limit = { ...limit, ...rule.limit }
  }
  if (limit) info.limit = limit

  if (rules.length > 1) info.via = rules.map((rule) => rule.from)
  return info
}

function matchExactAlias(catalog: Catalog, needle: string): CatalogMatch | undefined {
  const rule = CATALOG_ALIASES.find((item) => item.kind === "exact" && item.from === needle)
  if (!rule?.to) return undefined

  const match = matchDirect(catalog, rule.to)
  if (!match) return undefined
  return { ...match, alias: combineAliases([rule]) }
}

/**
 * Prefix aliases (`k3*` → `kimi-k3*`) are strict: the target must exist as a
 * catalog id with the same suffix. No family fallback and no "newest kimi-k3*"
 * fallback — a missing target means the model is not found.
 */
function matchPrefixAlias(catalog: Catalog, needle: string): CatalogMatch | undefined {
  for (const rule of CATALOG_ALIASES) {
    if (rule.kind !== "prefix" || !rule.to) continue
    if (!needle.startsWith(rule.from)) continue

    const target = `${rule.to}${needle.slice(rule.from.length)}`
    if (!target || target === needle) continue

    const match = matchID(catalog, target)
    if (match) return { ...match, alias: combineAliases([rule]) }
  }
  return undefined
}

const MAX_SUFFIX_MODIFIERS = 4

/**
 * Strips `-highspeed` / `-256k` from the right, then resolves the base through
 * direct → exact → prefix. Not recursive: all trailing modifiers are removed
 * in one pass, so combined suffixes such as `-256k-highspeed` keep their
 * left-to-right order in the display name.
 */
function matchSuffixAlias(catalog: Catalog, needle: string): CatalogMatch | undefined {
  let base = needle
  const applied: CatalogAliasRule[] = []

  while (applied.length < MAX_SUFFIX_MODIFIERS) {
    const rule = CATALOG_ALIASES.find((item) => item.kind === "suffix" && base.endsWith(item.from))
    if (!rule) break

    const next = base.slice(0, -rule.from.length)
    if (!next) return undefined
    applied.unshift(rule)
    base = next
  }

  if (applied.length === 0) return undefined

  const match =
    matchDirect(catalog, base) ??
    matchExactAlias(catalog, base) ??
    matchPrefixAlias(catalog, base)
  if (!match) return undefined

  const suffixInfo = combineAliases(applied)
  const info: CatalogAliasInfo = {
    kind: "suffix",
    from: suffixInfo.from,
  }
  if (match.alias?.to) info.to = match.alias.to
  if (match.alias?.name) info.name = match.alias.name
  const nameSuffix = `${match.alias?.nameSuffix ?? ""}${suffixInfo.nameSuffix ?? ""}`
  if (nameSuffix) info.nameSuffix = nameSuffix
  const limit = { ...match.alias?.limit, ...suffixInfo.limit }
  if (Object.keys(limit).length > 0) info.limit = limit
  if (suffixInfo.via) info.via = suffixInfo.via

  return { ...match, alias: info }
}

/**
 * Finds the catalog entry for a model basename (the last "/"-separated
 * segment of the TrustChat id).
 *
 * Priority:
 * 1. direct id suffix (canonical id equals the basename or ends with
 *    "/<basename>");
 * 2. exact `family` equality;
 * 3. exact alias (`glm-5.3-flashx`, `kimi-for-coding`);
 * 4. prefix alias (`k3*` → `kimi-k3*`, suffix preserved);
 * 5. trailing modifier (`-highspeed`, `-256k`): strip it and re-run 1–4.
 *
 * Native catalog entries always win: if the catalog contains
 * `<id>-highspeed` or `<id>-256k`, the modifier is not applied and the catalog
 * name/limits are used as-is. Among the candidates of the winning direct rule
 * the newest model is picked. Exact aliases resolve through the direct lookup
 * (id suffix or exact family); prefix aliases require an exact id target with
 * the preserved suffix and never fall back to a family or a newer sibling.
 */
export function resolveCatalogEntry(catalog: Catalog, basename: string): CatalogMatch | undefined {
  const needle = nonEmptyString(basename)?.toLowerCase()
  if (!catalog || !needle) return undefined

  return (
    matchDirect(catalog, needle) ??
    matchExactAlias(catalog, needle) ??
    matchPrefixAlias(catalog, needle) ??
    matchSuffixAlias(catalog, needle)
  )
}

/* ------------------------------------------------------------------ */
/* Model metadata                                                      */
/* ------------------------------------------------------------------ */

export const INPUT_MODALITIES = ["text", "audio", "image", "video", "pdf"] as const

export interface LimitDefaults {
  context: number
  output: number
}

export interface ResolveModelMetaInput {
  match?: CatalogMatch
  basename: string
  defaults: LimitDefaults
}

export interface ModelMeta {
  name: string
  input: string[]
  /** Catalog `reasoning: true`: the caller exposes reasoning effort levels. */
  reasoning: boolean
  context: number
  /** Always <= `context`. */
  outputLimit: number
}

function filterModalities(value: string[] | undefined): string[] | undefined {
  if (!value) return undefined
  const filtered = value.filter((item) =>
    (INPUT_MODALITIES as readonly string[]).includes(item),
  )
  return filtered.length > 0 ? filtered : undefined
}

/**
 * Builds model metadata from a catalog match.
 * Models are never looked up in a built-in table: without a match the
 * caller's defaults are used and the raw basename is the display name.
 *
 * The name is `alias.name → catalog name → basename`, followed by the alias
 * modifier (`" highspeed"` / `" 256K"`). Alias limits are applied on top of
 * the catalog limits, then the output limit is capped at the context window.
 */
export function resolveModelMeta(input: ResolveModelMetaInput): ModelMeta {
  const { match, basename, defaults } = input
  const model = match?.model

  const baseName = match?.alias?.name ?? model?.name ?? basename
  const name = match?.alias?.nameSuffix ? `${baseName}${match.alias.nameSuffix}` : baseName

  let context = model?.limit?.context ?? defaults.context
  let outputLimit = model?.limit?.output ?? defaults.output

  const aliasLimit = match?.alias?.limit
  if (aliasLimit?.context !== undefined && aliasLimit.context > 0) context = aliasLimit.context
  if (aliasLimit?.output !== undefined && aliasLimit.output > 0) outputLimit = aliasLimit.output

  return {
    name,
    input: filterModalities(model?.modalities?.input) ?? ["text"],
    reasoning: model?.reasoning === true,
    context,
    // No token limit can exceed the context window.
    outputLimit: Math.min(outputLimit, context),
  }
}

/* ------------------------------------------------------------------ */
/* Cache + network loader                                              */
/* ------------------------------------------------------------------ */

export type CatalogLog = (level: "info" | "warn", message: string) => void

export interface CatalogSourceOptions {
  url?: string
  /** Absolute path of the disk cache. */
  cacheFile: string
  timeoutMs?: number
  ttlMs?: number
  maxBytes?: number
  fetchImpl?: typeof fetch
  log?: CatalogLog
}

export interface CatalogSource {
  /**
   * Best available catalog. Never throws. Order: in-memory snapshot -> disk
   * cache -> network. Network is attempted only when there is no snapshot or it
   * is older than `ttlMs`, and not more often than once per 10 minutes per
   * process (failed attempts count). On network failure or abort the
   * stale/disk snapshot is returned (or undefined if there is none).
   */
  load(signal?: AbortSignal): Promise<Catalog | undefined>
}

interface Snapshot {
  catalog: Catalog
  /** Raw models.json text, written back to the cache. */
  body: string
  etag?: string
  /** Epoch ms of the last successful fetch or 304; 0 when unknown. */
  fetchedAt: number
}

interface CachePayload {
  etag?: string
  fetchedAt: number
  body: string
}

/**
 * Per-user cache file for the catalog: `XDG_CACHE_HOME` everywhere,
 * `LOCALAPPDATA` on Windows, `~/Library/Caches` on macOS and `~/.cache`
 * elsewhere, each followed by `pi/trustchat/models.json`.
 */
export function defaultCatalogCacheFile(): string {
  const xdg = process.env.XDG_CACHE_HOME?.trim()
  if (xdg) return join(xdg, ...CACHE_SUBPATH)

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local")
    return join(localAppData, ...CACHE_SUBPATH)
  }

  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", ...CACHE_SUBPATH)

  return join(homedir(), ".cache", ...CACHE_SUBPATH)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Removes the UTF-8 BOM that Windows editors like to prepend. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Reads a response body while enforcing `maxBytes`, so a missing or lying
 * `content-length` cannot make the extension buffer an arbitrarily large body.
 * Returns undefined when the limit is exceeded; read errors are rethrown.
 */
async function readTextLimited(
  response: Response,
  maxBytes: number,
): Promise<string | undefined> {
  if (!response.body) return ""

  const chunks: Uint8Array[] = []
  let total = 0

  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength
    if (total > maxBytes) return undefined
    chunks.push(chunk)
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")
}

/**
 * Renames `temp` over `target`. Windows refuses to replace an existing file
 * (`EEXIST`/`EPERM`/`EACCES`/`EBUSY`), so the target is removed and the rename
 * is retried a couple of times. Never throws: a failure is only logged, the
 * caller keeps working with whatever is in memory.
 */
async function replaceFile(temp: string, target: string, log: CatalogLog): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rename(temp, target)
      return
    } catch (error) {
      const code = errorCode(error)
      if (!code || !REPLACE_RETRY_CODES.has(code) || attempt === 2) {
        log("warn", `catalog: failed to replace cache ${target}: ${errorMessage(error)}`)
        return
      }
      // Unlink the target itself; symlinks are removed, never followed.
      await rm(target, { force: true }).catch(() => {})
      await sleep(25 * (attempt + 1))
    }
  }
}

export function createCatalogSource(options: CatalogSourceOptions): CatalogSource {
  const url = options.url ?? DEFAULT_CATALOG_URL
  const cacheFile = options.cacheFile
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const fetchImpl = options.fetchImpl ?? fetch
  const log: CatalogLog = options.log ?? (() => {})

  /** Undefined until the disk cache has been read once, then the best copy. */
  let snapshot: Snapshot | undefined
  let diskRead = false
  /** Time of the last network attempt, successful or not (throttling). */
  let lastAttemptAt = 0
  let pending: Promise<Catalog | undefined> | undefined

  async function writeCache(current: Snapshot): Promise<void> {
    const payload: CachePayload = { fetchedAt: current.fetchedAt, body: current.body }
    if (current.etag) payload.etag = current.etag

    // Temporary file in the same directory so the rename stays atomic.
    const temp = `${cacheFile}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
    try {
      await mkdir(dirname(cacheFile), { recursive: true })
      // mode is ignored on Windows, where it does not throw either.
      await writeFile(temp, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 })
      await replaceFile(temp, cacheFile, log)
    } catch (error) {
      // Read-only cache directory, missing permissions, disk full, ...
      log("warn", `catalog: failed to write cache ${cacheFile}: ${errorMessage(error)}`)
    } finally {
      await unlink(temp).catch(() => {})
    }
  }

  /** Reads the disk cache. Never throws; returns undefined when unusable. */
  async function readCache(): Promise<Snapshot | undefined> {
    try {
      const info = await stat(cacheFile)
      // An oversized cache file is treated like a broken one: ignored without
      // reading it into memory.
      if (!info.isFile() || info.size > maxBytes) return undefined

      const raw = stripBom(await readFile(cacheFile, "utf8"))
      const parsed: unknown = JSON.parse(raw)
      if (!isRecord(parsed)) return undefined
      if (typeof parsed.body !== "string" || !parsed.body.trim()) return undefined

      const catalog = parseCatalog(JSON.parse(stripBom(parsed.body)))
      if (!catalog) return undefined

      const fetchedAt =
        typeof parsed.fetchedAt === "number" && Number.isFinite(parsed.fetchedAt) && parsed.fetchedAt > 0
          ? Math.trunc(parsed.fetchedAt)
          : 0

      return { catalog, body: parsed.body, etag: nonEmptyString(parsed.etag), fetchedAt }
    } catch {
      return undefined
    }
  }

  /** One network attempt. Returns the new snapshot, or undefined on failure. */
  async function fetchOnce(signal: AbortSignal): Promise<Snapshot | undefined> {
    const headers: Record<string, string> = { Accept: "application/json" }
    if (snapshot?.etag) headers["If-None-Match"] = snapshot.etag

    const response = await fetchImpl(url, { headers, signal })

    if (response.status === 304) {
      if (!snapshot) {
        log("warn", "catalog: got 304 without a cached copy")
        return undefined
      }
      return { ...snapshot, fetchedAt: Date.now() }
    }

    if (!response.ok) {
      log("warn", `catalog: ${url} answered HTTP ${response.status}`)
      return undefined
    }

    const declared = Number(response.headers.get("content-length"))
    if (Number.isFinite(declared) && declared > maxBytes) {
      log("warn", `catalog: response too large (${declared} bytes > ${maxBytes})`)
      return undefined
    }

    const text = await readTextLimited(response, maxBytes)
    if (text === undefined) {
      log("warn", `catalog: response body exceeds ${maxBytes} bytes`)
      return undefined
    }

    let raw: unknown
    try {
      raw = JSON.parse(stripBom(text))
    } catch {
      log("warn", "catalog: response is not valid JSON")
      return undefined
    }

    const catalog = parseCatalog(raw)
    if (!catalog) {
      log("warn", "catalog: response has no usable models")
      return undefined
    }

    log("info", `catalog: fetched ${Object.keys(catalog.models).length} model(s) from ${url}`)
    return { catalog, body: text, etag: nonEmptyString(response.headers.get("etag")), fetchedAt: Date.now() }
  }

  async function loadOnce(signal: AbortSignal | undefined): Promise<Catalog | undefined> {
    if (!diskRead) {
      diskRead = true
      snapshot = await readCache()
    }

    const now = Date.now()
    if (snapshot && snapshot.fetchedAt > 0 && now - snapshot.fetchedAt <= ttlMs) return snapshot.catalog
    // Throttling counts every attempt, including failed ones, so a broken
    // catalog endpoint is not hammered on every load.
    if (lastAttemptAt > 0 && now - lastAttemptAt < MIN_REFRESH_INTERVAL_MS) return snapshot?.catalog
    if (signal?.aborted) return snapshot?.catalog

    lastAttemptAt = now
    try {
      const timeout = AbortSignal.timeout(timeoutMs)
      const next = await fetchOnce(signal ? AbortSignal.any([signal, timeout]) : timeout)
      if (next) {
        snapshot = next
        await writeCache(next)
      }
    } catch (error) {
      log("warn", `catalog: request to ${url} failed: ${errorMessage(error)}`)
    }
    return snapshot?.catalog
  }

  return {
    load: (signal) => {
      if (pending) return pending
      pending = loadOnce(signal).finally(() => {
        pending = undefined
      })
      return pending
    },
  }
}
