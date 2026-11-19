/**
 * Pure helpers for the TrustChat gateway model list: parsing GET /models,
 * the display-name suffix ladder and the mapping onto pi model configs.
 * No I/O and no logging of its own; diagnostics go through `log`.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent"

import { resolveCatalogEntry, resolveModelMeta, type Catalog, type ModelMeta } from "./models-dev.ts"

export type ChatModelConfig = Extract<ProviderModelConfig, { type?: "chat" }>

// Used when the catalog is disabled or not available. The display name in
// that case is the raw basename.
export const DEFAULT_LIMITS = { context: 128_000, output: 16_384 }

/* ------------------------------------------------------------------ */
/* GET /models payload                                                 */
/* ------------------------------------------------------------------ */

function modelIDOf(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined
  if (value && typeof value === "object" && "id" in value && typeof (value as any).id === "string") {
    return (value as any).id.trim() || undefined
  }
  return undefined
}

function payloadEntries(payload: unknown): unknown[] | undefined {
  if (Array.isArray(payload)) return payload
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {}
  if (Array.isArray(record.data)) return record.data
  if (Array.isArray(record.models)) return record.models
  return undefined
}

/**
 * The single normalization pass for a GET /models payload: unique, trimmed
 * model ids sorted by id. Accepts `[...]`, `{ data: [...] }` and
 * `{ models: [...] }` whose entries are strings or objects with a string
 * `id`. Returns undefined for any other shape, and for a non-empty list
 * without a single usable id, so a broken response is never mistaken for an
 * empty model list.
 */
export function parseModelIDs(payload: unknown): string[] | undefined {
  const entries = payloadEntries(payload)
  if (!entries) return undefined

  const ids = new Set<string>()
  for (const entry of entries) {
    const id = modelIDOf(entry)
    if (id) ids.add(id)
  }
  if (entries.length > 0 && ids.size === 0) return undefined
  return [...ids].sort((a, b) => a.localeCompare(b))
}

/* ------------------------------------------------------------------ */
/* Display-name suffix ladder (ported from the plugin)                 */
/* ------------------------------------------------------------------ */

// Model ids look like "<model>", "<role>/<model>", "<role>/<variant>/<model>"
// or deeper. The basename is the LAST "/"-separated segment; see the plugin's
// original comments for the full naming rules.
function basenameOf(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1)
}

interface SuffixCandidate {
  id: string
  prefix: string[]
  fixed: boolean
  size: number
}

function suffixParts(candidate: SuffixCandidate): string[] {
  if (candidate.size === 0) return []
  return candidate.prefix.slice(-candidate.size).filter((part) => part !== "")
}

function canGrow(candidate: SuffixCandidate): boolean {
  return !candidate.fixed && candidate.size > 0 && candidate.size < candidate.prefix.length
}

function grow(candidate: SuffixCandidate): void {
  if (!canGrow(candidate)) return
  candidate.size += 1
  while (candidate.size < candidate.prefix.length && suffixParts(candidate).length === 0) {
    candidate.size += 1
  }
}

/**
 * The "minimal suffix ladder" for the ids sharing one basename; identical to
 * the plugin's implementation (2-segment ids always show the role, 3+ segment
 * ids escalate only on collisions).
 */
function groupSuffixParts(ids: string[]): Map<string, string> {
  const unique = ids.length === 1
  const members: SuffixCandidate[] = ids.map((id) => {
    const prefix = id.split("/").slice(0, -1)
    let size = 1
    if (prefix.length === 0) size = 0
    else if (prefix.length >= 2 && unique) size = 0
    return { id, prefix, fixed: prefix.length === 1, size }
  })

  for (const member of members) {
    if (suffixParts(member).length === 0) grow(member)
  }

  for (;;) {
    const counts = new Map<string, number>()
    for (const member of members) {
      const key = suffixParts(member).join("/")
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }

    let changed = false
    for (const member of members) {
      const key = suffixParts(member).join("/")
      if (!key || (counts.get(key) ?? 0) < 2 || !canGrow(member)) continue
      grow(member)
      changed = true
    }
    if (!changed) break
  }

  const result = new Map<string, string>()
  for (const member of members) {
    const parts = suffixParts(member)
    if (parts.length > 0) result.set(member.id, parts.join("/"))
  }
  return result
}

function modelSuffixes(ids: readonly string[]): Map<string, string> {
  const groups = new Map<string, string[]>()
  for (const id of ids) {
    const group = groups.get(basenameOf(id))
    if (group) group.push(id)
    else groups.set(basenameOf(id), [id])
  }

  const suffixes = new Map<string, string>()
  for (const group of groups.values()) {
    for (const [id, parts] of groupSuffixParts(group)) suffixes.set(id, ` (${parts})`)
  }
  return suffixes
}

/* ------------------------------------------------------------------ */
/* pi models                                                           */
/* ------------------------------------------------------------------ */

/**
 * Maps one resolved model onto pi's ProviderModelConfig. `id` is what the user
 * selects in pi; `gatewayID` is what the gateway expects in the request.
 */
function toPiModel(id: string, gatewayID: string, meta: ModelMeta, suffix: string): ChatModelConfig {
  const input: ("text" | "image")[] = meta.input.includes("image") ? ["text", "image"] : ["text"]
  return {
    type: "chat",
    id,
    name: `${meta.name}${suffix}`,
    input,
    // TrustChat has its own billing, so catalog prices must not leak here.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: meta.reasoning,
    contextWindow: meta.context,
    maxTokens: meta.outputLimit,
    // GLM Flash rejects Pi's default developer role for reasoning models.
    compat: { maxTokensField: "max_tokens", supportsDeveloperRole: false },
    // pi applies samplingParams last, over the named request fields, so this
    // puts the full gateway id back into the request's `model`.
    ...(id !== gatewayID ? { samplingParams: { model: gatewayID } } : {}),
  }
}

/** Catalog metadata for one basename, or undefined when the model is skipped. */
function basenameMeta(
  basename: string,
  catalog: Catalog | undefined,
  log: (message: string) => void,
): ModelMeta | undefined {
  const match = catalog ? resolveCatalogEntry(catalog, basename) : undefined
  if (match) {
    log(`catalog: ${basename} -> ${match.id} (source=${match.source})`)
  } else if (catalog) {
    log(`catalog: no match for "${basename}"; skipping`)
    return undefined
  }
  return resolveModelMeta({ match, basename, defaults: DEFAULT_LIMITS })
}

/**
 * Builds the pi model list from normalized ids (see `parseModelIDs`); the
 * output keeps the input order.
 *
 * The pi model id is the basename ("corp-key144/glm-5.3" -> "glm-5.3") when
 * no other gateway id shares it; colliding ids keep the full gateway id.
 *
 * When a catalog snapshot is available, models whose basename resolves to
 * nothing in models.dev are skipped (pi has no "disabled" flag; the OpenCode
 * plugin disabled them). Without a catalog every model is kept with defaults.
 */
export function buildModels(
  ids: readonly string[],
  catalog: Catalog | undefined,
  log: (message: string) => void = () => {},
): ChatModelConfig[] {
  const suffixes = modelSuffixes(ids)
  const basenameCounts = new Map<string, number>()
  for (const id of ids) basenameCounts.set(basenameOf(id), (basenameCounts.get(basenameOf(id)) ?? 0) + 1)
  const metas = new Map<string, ModelMeta | undefined>()
  const models: ChatModelConfig[] = []

  for (const id of ids) {
    const basename = basenameOf(id)
    if (!metas.has(basename)) metas.set(basename, basenameMeta(basename, catalog, log))
    const meta = metas.get(basename)
    if (!meta) continue
    const piID = basename && basenameCounts.get(basename) === 1 ? basename : id
    models.push(toPiModel(piID, id, meta, suffixes.get(id) ?? ""))
  }
  return models
}
