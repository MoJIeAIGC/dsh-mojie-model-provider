import {
  assertUsableApiKey,
  attributionHeaders,
  LlmError,
  type LlmDiscoveredModel,
  type LlmModelDiscoveryRequest,
  type ModelModality,
} from '@deepseek-ai/dsh-llm'
import { modelsURL, normalizeBaseURL } from './core/endpoint.js'
import type { ResolvedConfig } from './config.js'
import { mergeCatalog } from './catalog.js'

interface ModelsEnvelope {
  object?: unknown
  data?: unknown
}

interface ModelsRow {
  id?: unknown
  object?: unknown
  owned_by?: unknown
  name?: unknown
  context_length?: unknown
  context_window?: unknown
  max_output_tokens?: unknown
  input_modalities?: unknown
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}

function asModalities(value: unknown): ModelModality[] | undefined {
  if (!Array.isArray(value)) return undefined
  const known = value.filter((entry): entry is ModelModality => entry === 'text' || entry === 'image')
  if (known.length === 0) return undefined
  return [...new Set(known)]
}

/**
 * Read Mojie's `/v1/models` listing from one base URL.
 * @param baseURL - Mojie site root or the same root with `/v1`.
 * @param apiKey - raw API key.
 * @param signal - optional cancellation.
 * @returns advisory model rows in endpoint order.
 */
export async function fetchModelListing(
  baseURL: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<LlmDiscoveredModel[]> {
  const normalized = normalizeBaseURL(baseURL)
  const usable = assertUsableApiKey(apiKey, 'mojie', 'apiKeyEnv')
  let response: Response
  try {
    response = await fetch(modelsURL(normalized), {
      method: 'GET',
      headers: {
        ...attributionHeaders(),
        'accept': 'application/json',
        'authorization': `Bearer ${usable}`,
      },
      ...signal === undefined ? {} : { signal },
    })
  } catch (cause) {
    if (signal?.aborted) throw new LlmError('Mojie model discovery aborted', 'ABORTED', { cause: cause as Error })
    throw new LlmError(`Could not reach ${modelsURL(normalized)}`, 'DISCOVERY_FAILED', { cause: cause as Error })
  }
  if (!response.ok) {
    throw new LlmError(
      `${modelsURL(normalized)} answered ${response.status}${response.status === 401 || response.status === 403 ? '; check the API key' : ''}`,
      'DISCOVERY_FAILED',
      { status: response.status },
    )
  }
  let body: unknown
  try {
    body = JSON.parse(await response.text())
  } catch (cause) {
    throw new LlmError(`${modelsURL(normalized)} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: cause as Error })
  }
  return readListing(body)
}

/**
 * Interrogate Mojie from a settings-page draft request.
 * @param config - current plugin configuration, used as fallback when the draft omits a field.
 * @param request - draft endpoint and one-shot key.
 * @param signal - optional cancellation.
 * @returns discovered models in endpoint order.
 */
export async function discoverDraftModels(
  config: ResolvedConfig,
  request: LlmModelDiscoveryRequest,
  signal?: AbortSignal,
): Promise<LlmDiscoveredModel[]> {
  const baseURL = request.baseURL ?? config.baseURL
  if (request.apiKey === undefined) {
    throw new LlmError('mojie model discovery requires an API key', 'MISSING_CREDENTIAL')
  }
  return fetchModelListing(baseURL, request.apiKey, signal)
}

/**
 * Read the advisory route catalog from live discovery.
 *
 * The route id is not needed: one listing answers for the endpoint, and the
 * caller merges it with its own configured entries.
 * @param config - current plugin configuration.
 * @param apiKey - resolved API key for this discovery operation.
 * @param signal - optional cancellation.
 * @returns discovered model rows.
 */
export async function listRouteModels(
  config: ResolvedConfig,
  apiKey: string,
  signal?: AbortSignal,
): Promise<readonly LlmDiscoveredModel[]> {
  return fetchModelListing(config.baseURL, apiKey, signal)
}

/**
 * Build the provider-facing selector catalog from config and live discovery.
 * @param provider - route id.
 * @param config - current plugin configuration.
 * @param apiKey - resolved API key for this discovery operation.
 * @param signal - optional cancellation.
 * @returns merged advisory model metadata.
 */
export async function buildProviderCatalog(
  provider: string,
  config: ResolvedConfig,
  apiKey: string,
  signal?: AbortSignal,
) {
  const discovered = await listRouteModels(config, apiKey, signal)
  return mergeCatalog(provider, config.models, discovered)
}

function readListing(body: unknown): LlmDiscoveredModel[] {
  const envelope = body as ModelsEnvelope | null
  if (envelope === null || typeof envelope !== 'object' || !Array.isArray(envelope.data)) {
    throw new LlmError('Mojie /v1/models has no data array', 'DISCOVERY_FAILED')
  }
  const result: LlmDiscoveredModel[] = []
  const seen = new Set<string>()
  for (const raw of envelope.data as ModelsRow[]) {
    const id = asString(raw.id)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    // Mojie publishes capacity metadata on /v1/models; carry it through so
    // compaction, output caps, and image input work without hand-written config.
    const contextWindow = asPositiveInteger(raw.context_length) ?? asPositiveInteger(raw.context_window)
    const maxTokens = asPositiveInteger(raw.max_output_tokens)
    const inputModalities = asModalities(raw.input_modalities)
    result.push({
      id,
      name: asString(raw.name) ?? id,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
      ...inputModalities === undefined ? {} : { inputModalities },
    })
  }
  return result
}
