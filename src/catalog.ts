import type { LlmDiscoveredModel, LlmModelInfo, LlmResolvedModelInfo, ModelModality, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId as brandReasoningEffort } from '@deepseek-ai/dsh-llm'
import { BUILTIN_CATALOG_MODELS } from './catalog.generated.js'
import type { MojieModelConfig } from './config.js'

/**
 * Built-in metadata for one Mojie model. `scripts/sync-catalog.mjs` writes the rows
 * from the live `/v1/models` listing, so this list follows the site instead of being
 * hand-maintained here.
 */
export interface MojieCatalogModel {
  id: string
  name: string
  description?: string
  contextWindow?: number
  maxTokens?: number
  inputModalities?: ModelModality[]
  reasoningEfforts?: ReasoningEffortId[]
  defaultReasoningEffort?: ReasoningEffortId
}

/** Snapshot lookup: built-ins keep the first request of a session correct before discovery answers. */
const BUILTIN_CATALOG: ReadonlyMap<string, MojieCatalogModel> = new Map(
  BUILTIN_CATALOG_MODELS.map((model) => [model.id, model]),
)

/**
 * Return built-in metadata for one known Mojie model.
 * @param id - exact provider model id.
 * @returns built-in metadata when known.
 */
export function builtinModel(id: string): MojieCatalogModel | undefined {
  return BUILTIN_CATALOG.get(id)
}

/**
 * Merge explicit config, built-in metadata, and remote discovery into one selector entry.
 * Explicit config wins over built-ins and discovery.
 * @param provider - route id.
 * @param id - exact model id.
 * @param configured - explicitly configured model entry, when present.
 * @param discovered - remote discovery entry, when present.
 * @returns merged list-model entry.
 */
export function mergeModelInfo(
  provider: string,
  id: string,
  configured?: MojieModelConfig,
  discovered?: LlmDiscoveredModel,
): LlmModelInfo {
  const builtin = builtinModel(id)
  // An explicit empty list is "no capability declared", not "accepts nothing".
  // Treat it as absent so built-in or discovered metadata can answer instead.
  const configuredModalities = configured?.inputModalities?.length ? configured.inputModalities : undefined
  const discoveredModalities = discovered?.inputModalities?.length ? discovered.inputModalities : undefined
  const builtinModalities = builtin?.inputModalities?.length ? builtin.inputModalities : undefined
  const inputModalities = configuredModalities ?? discoveredModalities ?? builtinModalities ?? ['text']
  return {
    provider,
    id,
    name: configured?.name ?? discovered?.name ?? builtin?.name ?? id,
    ...configured?.description !== undefined ? { description: configured.description } : builtin?.description !== undefined ? { description: builtin.description } : {},
    inputModalities: [...inputModalities],
  }
}

/**
 * Resolve exact model metadata with provider defaults and unknown-model fallbacks.
 * Unknown models default to text-only with their id as the display name.
 * @param provider - route id.
 * @param id - exact model id.
 * @param configured - explicitly configured model entry, when present.
 * @param discovered - remote discovery entry, when present.
 * @returns merged exact model metadata.
 */
export function mergeResolvedModelInfo(
  provider: string,
  id: string,
  configured?: MojieModelConfig,
  discovered?: LlmDiscoveredModel,
): LlmResolvedModelInfo {
  const builtin = builtinModel(id)
  const base = mergeModelInfo(provider, id, configured, discovered)
  const contextWindow = configured?.contextWindow ?? discovered?.contextWindow ?? builtin?.contextWindow
  const defaultMaxTokens = configured?.maxTokens ?? discovered?.maxTokens ?? builtin?.maxTokens
  const reasoningEfforts: readonly string[] | undefined = configured?.reasoningEfforts?.length
    ? configured.reasoningEfforts
    : builtin?.reasoningEfforts?.length
      ? builtin.reasoningEfforts
      : undefined
  return {
    ...base,
    ...contextWindow === undefined ? {} : { context: { contextWindow } },
    ...defaultMaxTokens === undefined ? {} : { defaultMaxTokens },
    ...configured?.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: configured.systemPromptUpdate },
    ...reasoningEfforts === undefined
      ? {}
      : {
        reasoning: {
          efforts: reasoningEfforts.map((effort) => ({ id: brandReasoningEffort(effort), name: String(effort) })),
          ...configured?.defaultReasoningEffort !== undefined && reasoningEfforts.includes(configured.defaultReasoningEffort)
            ? { defaultEffort: brandReasoningEffort(configured.defaultReasoningEffort) }
            : {},
        },
      },
  }
}

/**
 * Merge configured and discovered models into one advisory catalog.
 * Configured entries override the same ids from discovery; discovery still contributes additional ids.
 * @param provider - route id.
 * @param configured - explicit config entries.
 * @param discovered - remote discovery entries.
 * @returns merged catalog in config-first order, then discovery order.
 */
export function mergeCatalog(
  provider: string,
  configured: readonly MojieModelConfig[],
  discovered: readonly LlmDiscoveredModel[],
): LlmModelInfo[] {
  const discoveredMap = new Map(discovered.map((model) => [model.id, model]))
  const result: LlmModelInfo[] = []
  const seen = new Set<string>()
  for (const model of configured) {
    result.push(mergeModelInfo(provider, model.id, model, discoveredMap.get(model.id)))
    seen.add(model.id)
  }
  for (const model of discovered) {
    if (seen.has(model.id)) continue
    result.push(mergeModelInfo(provider, model.id, undefined, model))
    seen.add(model.id)
  }
  return result
}
