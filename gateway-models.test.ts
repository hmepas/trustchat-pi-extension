import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { buildModels, DEFAULT_LIMITS, parseModelIDs } from "./gateway-models.ts"
import { parseCatalog, type Catalog } from "./models-dev.ts"

const catalog = parseCatalog({
  "zai/glm-5": {
    id: "glm-5",
    name: "GLM 5",
    reasoning: true,
    modalities: { input: ["text", "image"] },
    limit: { context: 200_000, output: 300_000 },
  },
  "moonshot/kimi-k3": {
    id: "kimi-k3",
    name: "Kimi K3",
    modalities: { input: ["text"] },
    limit: { context: 256_000, output: 32_000 },
  },
}) as Catalog

function names(ids: string[]): Record<string, string> {
  return Object.fromEntries(buildModels(ids, catalog).map((model) => [model.id, model.name]))
}

describe("parseModelIDs", () => {
  test("accepts arrays, {data} and {models} with strings or {id} entries", () => {
    assert.deepEqual(parseModelIDs(["b", { id: "a" }]), ["a", "b"])
    assert.deepEqual(parseModelIDs({ data: [{ id: "x" }] }), ["x"])
    assert.deepEqual(parseModelIDs({ models: ["y"] }), ["y"])
  })

  test("dedups, trims and sorts in one pass", () => {
    assert.deepEqual(parseModelIDs({ data: [" b ", { id: "a" }, "b", { id: "a" }, "", 42] }), ["a", "b"])
  })

  test("an empty array is a valid empty list", () => {
    assert.deepEqual(parseModelIDs({ data: [] }), [])
    assert.deepEqual(parseModelIDs([]), [])
  })

  test("unknown shapes are rejected", () => {
    assert.equal(parseModelIDs({ error: "oops" }), undefined)
    assert.equal(parseModelIDs(null), undefined)
    assert.equal(parseModelIDs("models"), undefined)
    assert.equal(parseModelIDs({ data: "x" }), undefined)
    assert.equal(parseModelIDs({ data: [{ name: "no id" }] }), undefined)
  })
})

describe("buildModels suffix ladder", () => {
  test("a single-segment id has no suffix", () => {
    assert.deepEqual(names(["glm-5"]), { "glm-5": "GLM 5" })
  })

  test("a 2-segment id always shows its role", () => {
    assert.deepEqual(names(["coder/glm-5"]), { "coder/glm-5": "GLM 5 (coder)" })
  })

  test("a unique 3-segment id shows no suffix", () => {
    assert.deepEqual(names(["coder/fast/glm-5"]), { "coder/fast/glm-5": "GLM 5" })
  })

  test("3-segment ids escalate only on collision", () => {
    assert.deepEqual(names(["a/fast/glm-5", "b/fast/glm-5", "c/slow/glm-5"]), {
      "a/fast/glm-5": "GLM 5 (a/fast)",
      "b/fast/glm-5": "GLM 5 (b/fast)",
      "c/slow/glm-5": "GLM 5 (slow)",
    })
  })

  test("mixed depths of one basename", () => {
    assert.deepEqual(names(["glm-5", "coder/glm-5", "coder/fast/glm-5"]), {
      "glm-5": "GLM 5",
      "coder/glm-5": "GLM 5 (coder)",
      "coder/fast/glm-5": "GLM 5 (fast)",
    })
  })
})

describe("buildModels catalog mapping", () => {
  test("with a catalog, unmatched models are skipped", () => {
    const models = buildModels(["glm-5", "unknown-model"], catalog)
    assert.deepEqual(models.map((model) => model.id), ["glm-5"])
  })

  test("without a catalog, every model is kept with defaults", () => {
    const models = buildModels(["glm-5", "unknown-model"], undefined)
    assert.deepEqual(models.map((model) => model.id), ["glm-5", "unknown-model"])
    for (const model of models) {
      assert.equal(model.name, model.id)
      assert.equal(model.contextWindow, DEFAULT_LIMITS.context)
      assert.equal(model.maxTokens, DEFAULT_LIMITS.output)
      assert.deepEqual(model.input, ["text"])
      assert.equal(model.reasoning, false)
    }
    assert.deepEqual(DEFAULT_LIMITS, { context: 128_000, output: 16_384 })
  })

  test("maxTokens never exceeds contextWindow", () => {
    const [model] = buildModels(["glm-5"], catalog)
    assert.equal(model.contextWindow, 200_000)
    assert.equal(model.maxTokens, 200_000)
  })

  test("image input, reasoning, zero cost and compat are mapped", () => {
    const [glm, kimi] = buildModels(["glm-5", "kimi-k3"], catalog)
    assert.deepEqual(glm.input, ["text", "image"])
    assert.equal(glm.reasoning, true)
    assert.deepEqual(kimi.input, ["text"])
    assert.equal(kimi.reasoning, false)
    assert.deepEqual(glm.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    assert.deepEqual(glm.compat, { maxTokensField: "max_tokens", supportsDeveloperRole: false })
  })

  test("aliases still resolve (k3 prefix, -256k suffix)", () => {
    const models = buildModels(["glm-5-256k", "k3"], catalog)
    assert.deepEqual(
      models.map((model) => [model.id, model.name, model.contextWindow]),
      [
        ["glm-5-256k", "GLM 5 256K", 262_144],
        ["k3", "Kimi K3", 256_000],
      ],
    )
  })

  test("diagnostics go only to the injected log", () => {
    const messages: string[] = []
    buildModels(["glm-5", "x/unknown-model", "y/unknown-model"], catalog, (message) => messages.push(message))
    assert.deepEqual(messages, [
      "catalog: glm-5 -> zai/glm-5 (source=id)",
      'catalog: no match for "unknown-model"; skipping',
    ])
  })
})
