import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createCatalogSource,
  defaultCatalogCacheFile,
  parseCatalog,
  resolveCatalogEntry,
  resolveModelMeta,
  type Catalog,
} from "./models-dev.ts"

const RAW = {
  "zai/glm-5.3-flash": { id: "glm-5.3-flash", name: "GLM 5.3 Flash", limit: { context: 200_000, output: 131_072 } },
  "zai/glm-6": {
    id: "glm-6",
    name: "GLM 6",
    reasoning: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: 200_000, output: 131_072 },
  },
  "moonshotai/kimi-k3": { id: "kimi-k3", name: "Kimi K3", limit: { context: 131_072, output: 32_768 } },
  "moonshotai/kimi-k3.1-pro": { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro", limit: { context: 262_144, output: 65_536 } },
  "minimax/minimax-m3": { id: "minimax-m3", name: "MiniMax M3", limit: { context: 1_000_000, output: 128_000 } },
  "minimax/minimax-m3-highspeed": {
    id: "minimax-m3-highspeed",
    name: "MiniMax M3 Highspeed",
    limit: { context: 500_000, output: 64_000 },
  },
  "qwen/qwen4-coder": { id: "qwen4-coder", name: "Qwen4 Coder", limit: { context: 32_768 } },
}

const BODY = JSON.stringify(RAW)
const DEFAULTS = { context: 128_000, output: 128_000 }

function catalog(): Catalog {
  const parsed = parseCatalog(RAW)
  assert.ok(parsed)
  return parsed
}

function meta(basename: string) {
  return resolveModelMeta({ match: resolveCatalogEntry(catalog(), basename), basename, defaults: DEFAULTS })
}

describe("alias resolution", () => {
  it("exact alias glm-5.3-flashx", () => {
    const match = resolveCatalogEntry(catalog(), "glm-5.3-flashx")
    assert.equal(match?.id, "zai/glm-5.3-flash")
    assert.equal(meta("glm-5.3-flashx").name, "GLM 5.3 FlashX")
  })

  it("exact alias kimi-for-coding", () => {
    assert.equal(resolveCatalogEntry(catalog(), "kimi-for-coding")?.id, "moonshotai/kimi-k3.1-pro")
    assert.equal(meta("kimi-for-coding").name, "Kimi For Coding")
  })

  it("k3* prefix alias keeps the suffix", () => {
    assert.equal(resolveCatalogEntry(catalog(), "k3")?.id, "moonshotai/kimi-k3")
    assert.equal(resolveCatalogEntry(catalog(), "k3.1-pro")?.id, "moonshotai/kimi-k3.1-pro")
    assert.equal(resolveCatalogEntry(catalog(), "k3.9"), undefined)
  })

  it("-highspeed suffix", () => {
    const match = resolveCatalogEntry(catalog(), "glm-6-highspeed")
    assert.equal(match?.id, "zai/glm-6")
    const m = meta("glm-6-highspeed")
    assert.equal(m.name, "GLM 6 highspeed")
    assert.equal(m.context, 200_000)
  })

  it("-256k suffix overrides context", () => {
    const m = meta("glm-6-256k")
    assert.equal(m.name, "GLM 6 256K")
    assert.equal(m.context, 262_144)
    assert.equal(m.outputLimit, 131_072)
  })

  it("combined suffix keeps left-to-right order", () => {
    const m = meta("k3-256k-highspeed")
    assert.equal(resolveCatalogEntry(catalog(), "k3-256k-highspeed")?.id, "moonshotai/kimi-k3")
    assert.equal(m.name, "Kimi K3 256K highspeed")
    assert.equal(m.context, 262_144)
    assert.equal(m.outputLimit, 32_768)
  })

  it("native catalog entry wins over an alias", () => {
    const match = resolveCatalogEntry(catalog(), "minimax-m3-highspeed")
    assert.equal(match?.id, "minimax/minimax-m3-highspeed")
    assert.equal(match?.alias, undefined)
    const m = meta("minimax-m3-highspeed")
    assert.equal(m.name, "MiniMax M3 Highspeed")
    assert.equal(m.context, 500_000)
    assert.equal(m.outputLimit, 64_000)
  })
})

describe("model meta", () => {
  it("clamps the default output to the catalog context", () => {
    const m = meta("qwen4-coder")
    assert.equal(m.context, 32_768)
    assert.equal(m.outputLimit, 32_768)
  })

  it("-256k on a small-context model raises context, output stays default", () => {
    const m = meta("qwen4-coder-256k")
    assert.equal(m.context, 262_144)
    assert.equal(m.outputLimit, 128_000)
  })

  it("maps modalities and reasoning", () => {
    const m = meta("glm-6")
    assert.deepEqual(m.input, ["text", "image"])
    assert.equal(m.reasoning, true)
  })

  it("uses defaults without a match", () => {
    const m = meta("unknown-model")
    assert.deepEqual(m, { name: "unknown-model", input: ["text"], reasoning: false, context: 128_000, outputLimit: 128_000 })
  })

  it("clamps defaults too", () => {
    const m = resolveModelMeta({ basename: "x", defaults: { context: 8_000, output: 16_000 } })
    assert.equal(m.outputLimit, 8_000)
  })
})

describe("defaultCatalogCacheFile", () => {
  it("honors XDG_CACHE_HOME", () => {
    const previous = process.env.XDG_CACHE_HOME
    process.env.XDG_CACHE_HOME = "/tmp/xdg"
    try {
      assert.equal(defaultCatalogCacheFile(), join("/tmp/xdg", "pi", "trustchat", "models.json"))
    } finally {
      if (previous === undefined) delete process.env.XDG_CACHE_HOME
      else process.env.XDG_CACHE_HOME = previous
    }
  })
})

/* ------------------------------------------------------------------ */
/* load()                                                            */
/* ------------------------------------------------------------------ */

const TTL = 24 * 60 * 60 * 1000

interface FakeFetch {
  calls: { url: string; headers: Record<string, string> }[]
  impl: typeof fetch
}

function fakeFetch(respond: () => Response | Promise<Response>): FakeFetch {
  const calls: FakeFetch["calls"] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } })
    if (init?.signal?.aborted) throw init.signal.reason
    return respond()
  }) as typeof fetch
  return { calls, impl }
}

const ok = () => new Response(BODY, { status: 200, headers: { etag: '"v1"' } })
const fail = () => {
  throw new TypeError("fetch failed")
}

let dir: string
let cacheFile: string

async function writeCacheFile(fetchedAt: number, extra: Record<string, unknown> = {}) {
  await writeFile(cacheFile, JSON.stringify({ fetchedAt, body: BODY, ...extra }))
}

describe("CatalogSource.load", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "models-dev-test-"))
    cacheFile = join(dir, "sub", "models.json")
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("cold start fetches and writes the cache", async () => {
    const f = fakeFetch(ok)
    const source = createCatalogSource({ cacheFile, fetchImpl: f.impl })
    const result = await source.load()
    assert.equal(f.calls.length, 1)
    assert.ok(result?.models["zai/glm-6"])
    const cached = JSON.parse(await readFile(cacheFile, "utf8"))
    assert.equal(cached.body, BODY)
    assert.equal(cached.etag, '"v1"')
    assert.ok(Date.now() - cached.fetchedAt < 5_000)

    // Fresh in memory: no second fetch.
    await source.load()
    assert.equal(f.calls.length, 1)
  })

  it("fresh disk cache means zero fetch calls", async () => {
    cacheFile = join(dir, "models.json")
    await writeCacheFile(Date.now() - 1_000)
    const f = fakeFetch(ok)
    const result = await createCatalogSource({ cacheFile, fetchImpl: f.impl }).load()
    assert.equal(f.calls.length, 0)
    assert.ok(result?.models["qwen/qwen4-coder"])
  })

  it("stale cache triggers a fetch", async () => {
    cacheFile = join(dir, "models.json")
    await writeCacheFile(Date.now() - 2 * TTL)
    const f = fakeFetch(ok)
    const result = await createCatalogSource({ cacheFile, fetchImpl: f.impl }).load()
    assert.equal(f.calls.length, 1)
    assert.ok(result)
    const cached = JSON.parse(await readFile(cacheFile, "utf8"))
    assert.ok(Date.now() - cached.fetchedAt < 5_000)
  })

  it("network failure returns the stale snapshot (legacy digest key ignored)", async () => {
    cacheFile = join(dir, "models.json")
    await writeCacheFile(Date.now() - 2 * TTL, { digest: "deadbeef" })
    const f = fakeFetch(fail)
    const result = await createCatalogSource({ cacheFile, fetchImpl: f.impl }).load()
    assert.equal(f.calls.length, 1)
    assert.ok(result?.models["zai/glm-6"])
  })

  it("network failure with no cache returns undefined", async () => {
    const f = fakeFetch(fail)
    const result = await createCatalogSource({ cacheFile, fetchImpl: f.impl }).load()
    assert.equal(f.calls.length, 1)
    assert.equal(result, undefined)
  })

  it("HTTP error with no cache returns undefined", async () => {
    const f = fakeFetch(() => new Response("nope", { status: 500 }))
    const result = await createCatalogSource({ cacheFile, fetchImpl: f.impl }).load()
    assert.equal(result, undefined)
  })

  it("a second failing load within the throttle window does not fetch again", async () => {
    const f = fakeFetch(fail)
    const source = createCatalogSource({ cacheFile, fetchImpl: f.impl })
    assert.equal(await source.load(), undefined)
    assert.equal(await source.load(), undefined)
    assert.equal(f.calls.length, 1)
  })

  it("304 keeps the catalog and refreshes fetchedAt", async () => {
    cacheFile = join(dir, "models.json")
    await writeCacheFile(Date.now() - 2 * TTL, { etag: '"v0"' })
    const f = fakeFetch(() => new Response(null, { status: 304 }))
    const source = createCatalogSource({ cacheFile, fetchImpl: f.impl })
    const result = await source.load()
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].headers["If-None-Match"], '"v0"')
    assert.ok(result?.models["zai/glm-6"])
    const cached = JSON.parse(await readFile(cacheFile, "utf8"))
    assert.equal(cached.body, BODY)
    assert.equal(cached.etag, '"v0"')
    assert.ok(Date.now() - cached.fetchedAt < 5_000)
  })

  it("oversized response is rejected", async () => {
    const f = fakeFetch(ok)
    const result = await createCatalogSource({ cacheFile, fetchImpl: f.impl, maxBytes: 100 }).load()
    assert.equal(result, undefined)
  })

  it("an already-aborted signal does not throw", async () => {
    const controller = new AbortController()
    controller.abort()
    const f = fakeFetch(ok)
    const source = createCatalogSource({ cacheFile, fetchImpl: f.impl })
    assert.equal(await source.load(controller.signal), undefined)

    cacheFile = join(dir, "models.json")
    await writeCacheFile(Date.now() - 2 * TTL)
    const stale = await createCatalogSource({ cacheFile, fetchImpl: f.impl }).load(controller.signal)
    assert.ok(stale?.models["zai/glm-6"])
  })

  it("abort during the request returns the stale snapshot", async () => {
    cacheFile = join(dir, "models.json")
    await writeCacheFile(Date.now() - 2 * TTL)
    const controller = new AbortController()
    const impl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
        controller.abort()
      })) as unknown as typeof fetch
    const result = await createCatalogSource({ cacheFile, fetchImpl: impl }).load(controller.signal)
    assert.ok(result?.models["zai/glm-6"])
  })

  it("concurrent load() calls produce one fetch", async () => {
    const f = fakeFetch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return ok()
    })
    const source = createCatalogSource({ cacheFile, fetchImpl: f.impl })
    const [a, b, c] = await Promise.all([source.load(), source.load(), source.load()])
    assert.equal(f.calls.length, 1)
    assert.ok(a)
    assert.equal(a, b)
    assert.equal(b, c)
  })
})
