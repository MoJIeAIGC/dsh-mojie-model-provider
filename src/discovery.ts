import {
  LlmError,
  type LlmDiscoveredModel,
  type LlmModelDiscoveryRequest,
  type ModelModality,
} from '@deepseek-ai/dsh-llm'
import { mojieAuthHeaders } from './core/auth.js'
import { modelsURL, normalizeBaseURL } from './core/endpoint.js'
import type { ResolvedConfig } from './config.js'
import { mergeCatalog } from './catalog.js'

/**
 * One discovered model, plus the capability metadata Mojie discloses that
 * `LlmDiscoveredModel` has no field for.
 *
 * The generic discovery contract deliberately stays provider-neutral, so the
 * thinking fields live here and only `catalog.ts` reads them: the listing names
 * the selectable levels (`reasoning.levels`), whether thinking can be turned off
 * (`reasoning.can_disable`), and the site's default (`reasoning.default`). An
 * unlisted capability stays unknown and the vendor recommendation applies.
 */
export interface MojieDiscoveredModel extends LlmDiscoveredModel {
  /** `/v1/models` `supports_reasoning`; absent when the listing did not say. */
  readonly supportsReasoning?: boolean
  /** `/v1/models` `reasoning.levels`: exact effort ids the relay accepts. */
  readonly reasoningLevels?: readonly string[]
  /** `/v1/models` `reasoning.can_disable`: whether `none` is accepted. */
  readonly canDisableReasoning?: boolean
  /** `/v1/models` `reasoning.default`: `native`, `off`, or one of the levels. */
  readonly defaultReasoningEffort?: string
  /** `/v1/models` `features`: upstream capability tags (`tool-call`, `vision`, …). */
  readonly features?: readonly string[]
}

interface ModelsEnvelope {
  object?: unknown
  data?: unknown
}

interface ModelsReasoning {
  levels?: unknown
  can_disable?: unknown
  default?: unknown
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
  supports_reasoning?: unknown
  reasoning?: unknown
  features?: unknown
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

/** Selectable thinking levels as published, in the site's own ascending order. */
function asReasoningLevels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ids: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (id.length > 0 && !ids.includes(id)) ids.push(id)
  }
  return ids.length === 0 ? undefined : ids
}

/** Capability tags as published, deduplicated and trimmed; absent when none. */
function asFeatures(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tags: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const tag = entry.trim()
    if (tag.length > 0 && !tags.includes(tag)) tags.push(tag)
  }
  return tags.length === 0 ? undefined : tags
}

/**
 * Read the published thinking block without guessing at missing fields.
 *
 * `supports_reasoning` is the authority when present; otherwise a disclosed
 * `reasoning` object implies capability unless its default is `off`. The default
 * stays raw (`native` / `off` / a level) so `catalog.ts` can map it onto the
 * ladder it resolves.
 */
function asReasoning(row: ModelsRow): Pick<
  MojieDiscoveredModel,
  'supportsReasoning' | 'reasoningLevels' | 'canDisableReasoning' | 'defaultReasoningEffort'
> {
  const block = typeof row.reasoning === 'object' && row.reasoning !== null ? row.reasoning as ModelsReasoning : undefined
  const levels = block === undefined ? undefined : asReasoningLevels(block.levels)
  const canDisable = block?.can_disable === true ? true : undefined
  const publishedDefault = typeof block?.default === 'string' && block.default.length > 0 ? block.default : undefined
  const supportsReasoning = typeof row.supports_reasoning === 'boolean'
    ? row.supports_reasoning
    : block === undefined
      ? undefined
      : levels !== undefined || canDisable === true || publishedDefault !== 'off'
  return {
    ...supportsReasoning === undefined ? {} : { supportsReasoning },
    ...levels === undefined ? {} : { reasoningLevels: levels },
    ...canDisable === undefined ? {} : { canDisableReasoning: canDisable },
    ...publishedDefault === undefined ? {} : { defaultReasoningEffort: publishedDefault },
  }
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
): Promise<MojieDiscoveredModel[]> {
  const normalized = normalizeBaseURL(baseURL)
  let response: Response
  try {
    response = await fetch(modelsURL(normalized), {
      method: 'GET',
      headers: await mojieAuthHeaders(apiKey, { ref: 'apiKeyEnv', headers: { 'accept': 'application/json' } }),
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
): Promise<MojieDiscoveredModel[]> {
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
): Promise<readonly MojieDiscoveredModel[]> {
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

function readListing(body: unknown): MojieDiscoveredModel[] {
  const envelope = body as ModelsEnvelope | null
  if (envelope === null || typeof envelope !== 'object' || !Array.isArray(envelope.data)) {
    throw new LlmError('Mojie /v1/models has no data array', 'DISCOVERY_FAILED')
  }
  const result: MojieDiscoveredModel[] = []
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
    const reasoning = asReasoning(raw)
    const features = asFeatures(raw.features)
    result.push({
      id,
      name: asString(raw.name) ?? id,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
      ...inputModalities === undefined ? {} : { inputModalities },
      ...reasoning,
      ...features === undefined ? {} : { features },
    })
  }
  return result
}
