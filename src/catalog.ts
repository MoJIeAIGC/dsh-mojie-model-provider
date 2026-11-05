import type {
  LlmDiscoveredModel,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmResolvedModelInfo,
  ModelModality,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId as brandReasoningEffort } from '@deepseek-ai/dsh-llm'
import { BUILTIN_CATALOG_MODELS } from './catalog.generated.js'
import type { MojieModelConfig } from './config.js'
import type { MojieDiscoveredModel } from './discovery.js'
import { sortModelOrder } from './order.js'
import { describeEfforts, vendorReasoningProfile } from './reasoning.js'

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

/** Options that shape one exact-model resolution. */
export interface ResolveModelOptions {
  /**
   * Apply the per-vendor thinking ladder when neither the configuration nor the
   * built-in snapshot declares efforts. Defaults to on: the site publishes no
   * effort vocabulary, so the recommendation is the only useful answer, and the
   * parameter is sent whether or not the relay honors it.
   */
  readonly reasoningDefaults?: boolean
}

/**
 * Resolve the thinking ladder for one model.
 *
 * Order: an explicit per-model opt-out, then declared efforts (configuration,
 * then built-in snapshot), then the vendor recommendation. The recommendation is
 * skipped only when the caller disabled defaults or the live listing reports the
 * model cannot think at all; an unlisted capability stays optimistic so the first
 * request of a session still has a picker.
 * @param id - exact model id.
 * @param configured - explicitly configured model entry, when present.
 * @param builtin - shipped snapshot row, when known.
 * @param discovered - live discovery row, when the cache has one for this endpoint.
 * @param options - resolution switches.
 * @returns published reasoning metadata, or undefined when the model has no picker.
 */
function resolveReasoning(
  id: string,
  configured: MojieModelConfig | undefined,
  builtin: MojieCatalogModel | undefined,
  discovered: MojieDiscoveredModel | undefined,
  options: ResolveModelOptions,
): LlmModelReasoningInfo | undefined {
  if (configured?.reasoning === 'off') return undefined
  const profile = options.reasoningDefaults === false ? undefined : vendorReasoningProfile(id)
  const declaredIds: readonly string[] | undefined = configured?.reasoningEfforts?.length
    ? configured.reasoningEfforts
    : builtin?.reasoningEfforts?.length
      ? builtin.reasoningEfforts
      : undefined
  if (declaredIds !== undefined) {
    // A declared ladder may name levels the vendor profile does not know, so the
    // default has to appear in the declared list to be legal.
    const configuredDefault = configured?.defaultReasoningEffort ?? builtin?.defaultReasoningEffort
    const defaultEffort = configuredDefault !== undefined && declaredIds.includes(configuredDefault)
      ? configuredDefault
      : profile !== undefined && declaredIds.includes(profile.defaultEffort)
        ? profile.defaultEffort
        : undefined
    return {
      efforts: describeEfforts(declaredIds, profile).map((effort) => ({
        id: brandReasoningEffort(effort.id),
        name: effort.name,
        description: effort.description,
      })),
      ...defaultEffort === undefined ? {} : { defaultEffort: brandReasoningEffort(defaultEffort) },
    }
  }
  if (profile === undefined || discovered?.supportsReasoning === false) return undefined
  return {
    efforts: profile.efforts.map((effort) => ({
      id: brandReasoningEffort(effort.id),
      name: effort.name,
      description: effort.description,
    })),
    defaultEffort: brandReasoningEffort(profile.defaultEffort),
  }
}

/**
 * Resolve exact model metadata with provider defaults and unknown-model fallbacks.
 * Unknown models default to text-only with their id as the display name.
 * @param provider - route id.
 * @param id - exact model id.
 * @param configured - explicitly configured model entry, when present.
 * @param discovered - remote discovery entry, when present.
 * @param options - resolution switches (vendor thinking defaults).
 * @returns merged exact model metadata.
 */
export function mergeResolvedModelInfo(
  provider: string,
  id: string,
  configured?: MojieModelConfig,
  discovered?: MojieDiscoveredModel,
  options: ResolveModelOptions = {},
): LlmResolvedModelInfo {
  const builtin = builtinModel(id)
  const base = mergeModelInfo(provider, id, configured, discovered)
  const contextWindow = configured?.contextWindow ?? discovered?.contextWindow ?? builtin?.contextWindow
  const defaultMaxTokens = configured?.maxTokens ?? discovered?.maxTokens ?? builtin?.maxTokens
  const reasoning = resolveReasoning(id, configured, builtin, discovered, options)
  return {
    ...base,
    ...contextWindow === undefined ? {} : { context: { contextWindow } },
    ...defaultMaxTokens === undefined ? {} : { defaultMaxTokens },
    ...configured?.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: configured.systemPromptUpdate },
    ...reasoning === undefined ? {} : { reasoning },
  }
}

/**
 * Merge configured and discovered models into one advisory catalog.
 * Configured entries override the same ids from discovery; discovery still contributes additional ids.
 *
 * The result is ordered by display name (then id, numbers compared as numbers),
 * so the composer lists every vendor's models together and in alphabetical
 * order even when a new model was appended to the stored `models` list last.
 * @param provider - route id.
 * @param configured - explicit config entries.
 * @param discovered - remote discovery entries.
 * @returns merged catalog in selector display order.
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
  return sortModelOrder(result)
}
