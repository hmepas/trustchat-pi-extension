/**
 * TrustChat provider extension for the pi coding agent.
 *
 * Port of @trustchat/opencode-provider 0.3.2 (an OpenCode V2 plugin) to the
 * pi extension API:
 *
 *  - registers a "trustchat" provider backed by the OpenAI-compatible
 *    TrustChat gateway (POST {baseURL}/chat/completions);
 *  - discovers models from GET {baseURL}/models (bearer token) in pi's
 *    `refreshModels` hook, never in the factory, and persists the list in
 *    pi's models store so a new process shows it before any network call;
 *  - enriches names/limits/reasoning from the models.dev catalog
 *    (models-dev.ts), cached on disk; model list logic is in gateway-models.ts;
 *  - sends max_tokens instead of max_completion_tokens and reports zero cost:
 *    TrustChat bills outside models.dev prices.
 *
 * Authentication is resolved by pi: a credential stored via /login
 * ("TrustChat" → Enter API key) or the TRUSTCHAT_API_KEY environment variable.
 *
 * Optional environment overrides:
 *  - TRUSTCHAT_BASE_URL         (default https://trustchat.wb-bank.ru:8443/v1)
 *  - TRUSTCHAT_MODELS_DEV_URL   (default https://models.dev/models.json)
 *  - TRUSTCHAT_MODELS_DEV_DISABLED=1  disable the catalog (defaults only)
 *  - TRUSTCHAT_MODELS_DEV_CACHE absolute path to the catalog cache file
 *  - TRUSTCHAT_DEBUG=1          diagnostics to stderr (off by default)
 */

import { isAbsolute } from "node:path"

import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

import { buildModels, parseModelIDs, type ChatModelConfig } from "./gateway-models.ts"
import { createCatalogSource, defaultCatalogCacheFile } from "./models-dev.ts"

const PROVIDER_ID = "trustchat"
const PROVIDER_NAME = "TrustChat"
const PROVIDER_API = "openai-completions"
const DEFAULT_BASE_URL = "https://trustchat.wb-bank.ru:8443/v1"
const MODELS_TIMEOUT_MS = 15_000

function envString(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

function envFlag(name: string): boolean {
  return /^(1|true|yes)$/i.test(envString(name) ?? "")
}

function normalizeBaseURL(value: string | undefined): string {
  return (value ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
}

/** GET {baseURL}/models. Throws on network errors, non-2xx and unknown payloads. */
async function fetchModelIDs(baseURL: string, key: string, signal: AbortSignal): Promise<string[]> {
  const response = await fetch(`${baseURL}/models`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${key}`,
    },
    signal: AbortSignal.any([signal, AbortSignal.timeout(MODELS_TIMEOUT_MS)]),
  })
  if (!response.ok) {
    throw new Error(`GET ${baseURL}/models failed with ${response.status} ${response.statusText}`)
  }

  const ids = parseModelIDs(await response.json())
  if (!ids) throw new Error(`GET ${baseURL}/models returned an unrecognized payload`)
  return ids
}

/** pi's models store keeps full pi models; this provider's ones are restored as configs. */
function toStoredModels(models: ChatModelConfig[], baseURL: string): Model<Api>[] {
  return models.map((model) => ({ ...model, api: PROVIDER_API, provider: PROVIDER_ID, baseUrl: baseURL }))
}

function fromStoredModels(stored: NonNullable<RefreshModelsContext["stored"]>): ChatModelConfig[] {
  return stored.models
    .filter((model) => model.provider === PROVIDER_ID && (model.type ?? "chat") === "chat")
    // api and base URL always come from the current registration.
    .map(({ provider, api, baseUrl, ...model }) => model as ChatModelConfig)
}

export default function (pi: ExtensionAPI): void {
  const baseURL = normalizeBaseURL(envString("TRUSTCHAT_BASE_URL"))
  const log = envFlag("TRUSTCHAT_DEBUG")
    ? (message: string) => console.error(`[trustchat] ${message}`)
    : () => {}
  const cacheFile = envString("TRUSTCHAT_MODELS_DEV_CACHE")
  const catalogSource = envFlag("TRUSTCHAT_MODELS_DEV_DISABLED")
    ? undefined
    : createCatalogSource({
        url: envString("TRUSTCHAT_MODELS_DEV_URL"),
        cacheFile: cacheFile && isAbsolute(cacheFile) ? cacheFile : defaultCatalogCacheFile(),
        log: (_level, message) => log(message),
      })

  // The only mutable state: the list last handed to pi, returned whenever a
  // refresh cannot produce a newer one.
  let current: ChatModelConfig[] = []

  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: baseURL,
    api: PROVIDER_API,
    // Env-var fallback; a stored /login credential takes precedence.
    apiKey: "$TRUSTCHAT_API_KEY",
    models: current,
    refreshModels: async (context) => {
      // Restore phase: no network, the persisted list if there is one.
      if (!context.allowNetwork) {
        if (context.stored) current = fromStoredModels(context.stored)
        return current
      }

      const key = context.credential?.type === "api_key" ? context.credential.key?.trim() : undefined
      if (!key) return current

      // The catalog load never throws and is bounded by its own timeout.
      const [ids, catalog] = await Promise.all([
        fetchModelIDs(baseURL, key, context.signal),
        catalogSource?.load(context.signal),
      ])
      const models = buildModels(ids, catalog, log)

      if (!(await context.publish({ persist: { models: toStoredModels(models, baseURL), checkedAt: Date.now() } }))) {
        return current
      }
      current = models
      log(`refreshed ${models.length} model(s) from ${baseURL}`)
      return current
    },
  })
}
