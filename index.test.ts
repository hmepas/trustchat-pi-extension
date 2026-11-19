import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"

import extension from "./index.ts"

const BASE_URL = "http://gateway.test/v1"
const CATALOG_URL = "http://catalog.test/models.json"
const ENV_KEYS = [
  "TRUSTCHAT_BASE_URL",
  "TRUSTCHAT_MODELS_DEV_URL",
  "TRUSTCHAT_MODELS_DEV_CACHE",
  "TRUSTCHAT_MODELS_DEV_DISABLED",
  "TRUSTCHAT_DEBUG",
]

const CATALOG = {
  "zai/glm-5": { id: "glm-5", name: "GLM 5", limit: { context: 200_000, output: 32_000 } },
}

type Handler = (init: RequestInit | undefined) => Promise<Response> | Response

let tempDir: string
let savedEnv: Record<string, string | undefined>
let savedFetch: typeof fetch
let savedConsole: Record<string, unknown>
let consoleCalls: string[]
let requests: string[]

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** Never answers; rejects only when the request is aborted. */
function hang(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
  })
}

function delayed(ms: number, response: () => Response): Handler {
  return () => new Promise((resolve) => setTimeout(() => resolve(response()), ms))
}

/** Stubs fetch with a URL → handler map; must run before the factory. */
function stubFetch(routes: Record<string, Handler>): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push(url)
    const handler = routes[url]
    if (!handler) throw new Error(`unexpected request ${url}`)
    init?.signal?.throwIfAborted()
    return handler(init)
  }) as typeof fetch
}

function load(): any {
  let registered: { name: string; config: any } | undefined
  extension({
    registerProvider: (name: string, config: any) => {
      registered = { name, config }
    },
  } as any)
  assert.ok(registered)
  return registered
}

/** In-memory stand-in for pi's models store and refresh context. */
function createStore() {
  let entry: any
  return {
    get entry() {
      return entry
    },
    context(overrides: Record<string, unknown> = {}): any {
      return {
        allowNetwork: true,
        credential: { type: "api_key", key: "test-key" },
        signal: new AbortController().signal,
        stored: entry === undefined ? undefined : structuredClone(entry),
        publish: async (publication: any) => {
          if (publication.persist !== undefined) entry = structuredClone(publication.persist)
          publication.update?.()
          return true
        },
        ...overrides,
      }
    },
  }
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "trustchat-test-"))
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.TRUSTCHAT_BASE_URL = BASE_URL
  process.env.TRUSTCHAT_MODELS_DEV_URL = CATALOG_URL
  process.env.TRUSTCHAT_MODELS_DEV_CACHE = join(tempDir, "catalog.json")

  savedFetch = globalThis.fetch
  requests = []
  stubFetch({})

  consoleCalls = []
  savedConsole = {}
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    savedConsole[method] = console[method]
    console[method] = (...args: unknown[]) => {
      consoleCalls.push(`${method}: ${args.join(" ")}`)
    }
  }
})

afterEach(() => {
  Object.assign(console, savedConsole)
  globalThis.fetch = savedFetch
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  rmSync(tempDir, { recursive: true, force: true })
})

describe("factory", () => {
  test("registers the provider without network or console output", () => {
    const { name, config } = load()
    assert.equal(name, "trustchat")
    assert.equal(config.name, "TrustChat")
    assert.equal(config.baseUrl, BASE_URL)
    assert.equal(config.api, "openai-completions")
    assert.equal(config.apiKey, "$TRUSTCHAT_API_KEY")
    assert.deepEqual(config.models, [])
    assert.equal(typeof config.refreshModels, "function")
    assert.deepEqual(requests, [])
    assert.deepEqual(consoleCalls, [])
  })
})

describe("restore phase", () => {
  test("returns [] with nothing stored, without network", async () => {
    const { config } = load()
    const models = await config.refreshModels(createStore().context({ allowNetwork: false }))
    assert.deepEqual(models, [])
    assert.deepEqual(requests, [])
  })

  test("returns this provider's models from context.stored", async () => {
    const { config } = load()
    const stored = {
      models: [
        { id: "glm-5", name: "GLM 5", api: "openai-completions", provider: "trustchat", baseUrl: "http://old/v1",
          reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1000, maxTokens: 100 },
        { id: "other", name: "Other", api: "openai-completions", provider: "someone-else", baseUrl: "http://x",
          reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1000, maxTokens: 100 },
      ],
    }
    const models = await config.refreshModels(createStore().context({ allowNetwork: false, stored }))
    assert.deepEqual(models.map((model: any) => model.id), ["glm-5"])
    assert.equal(models[0].baseUrl, undefined, "stored base URL must not override the registration")
    assert.equal(models[0].provider, undefined)
    assert.deepEqual(requests, [])
  })
})

describe("network phase", () => {
  test("builds, persists full pi models and returns the list", async () => {
    stubFetch({
      [`${BASE_URL}/models`]: () => json({ data: [{ id: "glm-5" }, { id: "coder/glm-5" }, { id: "unknown" }] }),
      [CATALOG_URL]: () => json(CATALOG),
    })
    const { config } = load()
    const store = createStore()
    const models = await config.refreshModels(store.context())

    assert.deepEqual(
      models.map((model: any) => [model.id, model.name, model.contextWindow, model.maxTokens]),
      [
        ["coder/glm-5", "GLM 5 (coder)", 200_000, 32_000],
        ["glm-5", "GLM 5", 200_000, 32_000],
      ],
    )
    assert.equal(store.entry.models.length, 2)
    for (const model of store.entry.models) {
      assert.equal(model.provider, "trustchat")
      assert.equal(model.api, "openai-completions")
      assert.equal(model.baseUrl, BASE_URL)
    }
    assert.equal(typeof store.entry.checkedAt, "number")

    // A new process restores the same list from the store.
    const restored = await load().config.refreshModels(store.context({ allowNetwork: false }))
    assert.deepEqual(restored, models)
  })

  test("sends the pi-resolved key as a bearer token", async () => {
    let auth: string | null | undefined
    stubFetch({
      [`${BASE_URL}/models`]: (init) => {
        auth = new Headers(init?.headers).get("authorization")
        return json([])
      },
      [CATALOG_URL]: () => json(CATALOG),
    })
    await load().config.refreshModels(createStore().context())
    assert.equal(auth, "Bearer test-key")
  })

  test("no usable credential: no network, current list", async () => {
    const { config } = load()
    for (const credential of [undefined, { type: "api_key", key: "  " }, { type: "oauth", access: "x" }]) {
      assert.deepEqual(await config.refreshModels(createStore().context({ credential })), [])
    }
    assert.deepEqual(requests, [])
  })

  test("{data: []} is a valid empty list", async () => {
    stubFetch({ [`${BASE_URL}/models`]: () => json({ data: [] }), [CATALOG_URL]: () => json(CATALOG) })
    const store = createStore()
    assert.deepEqual(await load().config.refreshModels(store.context()), [])
    assert.deepEqual(store.entry.models, [])
  })

  test("an unknown payload throws and keeps the persisted list", async () => {
    let payload: unknown = { data: ["glm-5"] }
    stubFetch({ [`${BASE_URL}/models`]: () => json(payload), [CATALOG_URL]: () => json(CATALOG) })
    const { config } = load()
    const store = createStore()
    const before = await config.refreshModels(store.context())
    assert.equal(before.length, 1)

    payload = { error: "oops" }
    await assert.rejects(config.refreshModels(store.context()), /unrecognized payload/)
    assert.deepEqual(await config.refreshModels(store.context({ allowNetwork: false })), before)
    assert.equal(store.entry.models.length, 1)
  })

  test("non-2xx throws without persisting", async () => {
    stubFetch({ [`${BASE_URL}/models`]: () => json({ error: "no" }, 503), [CATALOG_URL]: () => json(CATALOG) })
    const store = createStore()
    await assert.rejects(load().config.refreshModels(store.context()), /failed with 503/)
    assert.equal(store.entry, undefined)
  })

  test("network errors throw", async () => {
    stubFetch({
      [`${BASE_URL}/models`]: () => {
        throw new TypeError("fetch failed")
      },
      [CATALOG_URL]: () => json(CATALOG),
    })
    await assert.rejects(load().config.refreshModels(createStore().context()), /fetch failed/)
  })

  test("an aborted signal rejects without publishing", async () => {
    stubFetch({ [`${BASE_URL}/models`]: hang, [CATALOG_URL]: hang })
    const controller = new AbortController()
    const store = createStore()
    const pending = load().config.refreshModels(store.context({ signal: controller.signal }))
    controller.abort()
    await assert.rejects(pending)
    assert.equal(store.entry, undefined)
  })

  test("/models and the catalog are fetched concurrently", async () => {
    stubFetch({
      [`${BASE_URL}/models`]: delayed(300, () => json(["glm-5"])),
      [CATALOG_URL]: delayed(300, () => json(CATALOG)),
    })
    const started = Date.now()
    const models = await load().config.refreshModels(createStore().context())
    const elapsed = Date.now() - started
    assert.equal(models[0].name, "GLM 5")
    assert.ok(elapsed < 550, `took ${elapsed}ms`)
  })

  test("a hanging catalog delays the list at most by its own 5s timeout", async () => {
    stubFetch({ [`${BASE_URL}/models`]: () => json(["glm-5", "unknown"]), [CATALOG_URL]: hang })
    const started = Date.now()
    const models = await load().config.refreshModels(createStore().context())
    const elapsed = Date.now() - started
    // No catalog: every model kept with defaults.
    assert.deepEqual(models.map((model: any) => model.id), ["glm-5", "unknown"])
    assert.equal(models[0].contextWindow, 128_000)
    assert.ok(elapsed < 6_500, `took ${elapsed}ms`)
  })

  test("the catalog can be disabled", async () => {
    process.env.TRUSTCHAT_MODELS_DEV_DISABLED = "1"
    stubFetch({ [`${BASE_URL}/models`]: () => json(["glm-5"]) })
    const models = await load().config.refreshModels(createStore().context())
    assert.equal(models[0].name, "glm-5")
    assert.deepEqual(requests, [`${BASE_URL}/models`])
  })
})

describe("logging", () => {
  const routes = () => ({
    [`${BASE_URL}/models`]: () => json(["glm-5", "unknown"]),
    [CATALOG_URL]: () => json(CATALOG),
  })

  test("no console output during refresh by default", async () => {
    stubFetch(routes())
    const { config } = load()
    await config.refreshModels(createStore().context({ allowNetwork: false }))
    await config.refreshModels(createStore().context())
    assert.deepEqual(consoleCalls, [])
  })

  test("TRUSTCHAT_DEBUG=1 routes diagnostics to console.error without the key", async () => {
    process.env.TRUSTCHAT_DEBUG = "1"
    stubFetch(routes())
    await load().config.refreshModels(createStore().context())
    assert.ok(consoleCalls.length > 0)
    for (const call of consoleCalls) {
      assert.match(call, /^error: \[trustchat\] /)
      assert.doesNotMatch(call, /test-key/)
    }
    assert.ok(consoleCalls.some((call) => call.includes('no match for "unknown"')))
    assert.ok(consoleCalls.some((call) => call.includes("refreshed 1 model(s)")))
  })
})
