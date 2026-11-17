import type {
  LlmDiscoveredModel,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmResolvedModelInfo,
  ModelModality,
} from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId as brandReasoningEffort } from '@deepseek-ai/dsh-llm'
import { BUILTIN_CATALOG_MODELS } from './catalog.generated.js'
import type { MojieModelConfig } from './config.js'
import type { MojieDiscoveredModel } from './discovery.js'
import { sortModelOrder } from './order.js'
import {
  defaultEffortFor,
  describeEfforts,
  publishedDefaultEffort,
  publishedEffortIds,
  vendorReasoningProfile,
} from './reasoning.js'

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
  /**
   * `/v1/models` `supports_reasoning`. Present on every generated row, which is
   * how a snapshot row says "the listing published thinking metadata": a `false`
   * value, or a `true` value with no selectable levels, suppresses the vendor
   * recommendation instead of guessing a ladder.
   */
  supportsReasoning?: boolean
  /** Selectable effort ids as published (ascending; includes `none` when disable is allowed). */
  reasoningEfforts?: readonly string[]
  /** Published default effort; absent means the provider's own default applies. */
  defaultReasoningEffort?: string
  /** Upstream capability tags as published (`tool-call`, `vision`, `document`, …). */
  features?: readonly string[]
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
   * Let the per-vendor recommendation fill in when the listing publishes no
   * ladder. Defaults to on. Published metadata always applies — this switch only
   * stops the guess, so a model that rules its thinking out stays without a
   * picker. Explicit per-model configuration always wins.
   */
  readonly reasoningDefaults?: boolean
}

/** One resolved ladder, as plain ids before branding. */
interface ResolvedLadder {
  readonly efforts: readonly string[]
  readonly defaultEffort?: string
}

/** Thinking metadata published by the live listing, when it disclosed any. */
function discoveredLadder(discovered: MojieDiscoveredModel | undefined): ResolvedLadder | undefined {
  if (discovered === undefined) return undefined
  const published = discovered.supportsReasoning !== undefined || discovered.reasoningLevels !== undefined
  if (!published) return undefined
  // A model the listing marks as non-thinking (or as always-on with no selectable
  // level) publishes no ladder at all; the empty list records that decision so the
  // vendor recommendation cannot override it.
  if (discovered.supportsReasoning === false) return { efforts: [] }
  const efforts = publishedEffortIds(discovered.reasoningLevels, discovered.canDisableReasoning)
  const defaultEffort = publishedDefaultEffort(discovered.defaultReasoningEffort, efforts)
  return { efforts, ...defaultEffort === undefined ? {} : { defaultEffort } }
}

/** Thinking metadata carried by the shipped snapshot, when it disclosed any. */
function builtinLadder(builtin: MojieCatalogModel | undefined): ResolvedLadder | undefined {
  if (builtin?.supportsReasoning === undefined) return undefined
  const efforts = builtin.reasoningEfforts ?? []
  if (!builtin.supportsReasoning) return { efforts: [] }
  const defaultEffort = builtin.defaultReasoningEffort !== undefined && efforts.includes(builtin.defaultReasoningEffort)
    ? builtin.defaultReasoningEffort
    : undefined
  return { efforts, ...defaultEffort === undefined ? {} : { defaultEffort } }
}

/** Brand one plain ladder into the shape DSH publishes. */
function ladderInfo(
  efforts: readonly string[],
  defaultEffort: string | undefined,
  profile: ReturnType<typeof vendorReasoningProfile>,
): LlmModelReasoningInfo {
  return {
    efforts: describeEfforts(efforts, profile).map((effort) => ({
      id: brandReasoningEffort(effort.id),
      name: effort.name,
      description: effort.description,
    })),
    ...defaultEffort === undefined ? {} : { defaultEffort: brandReasoningEffort(defaultEffort) },
  }
}

/**
 * Resolve the thinking ladder for one model.
 *
 * Order: an explicit per-model opt-out, then efforts declared in configuration,
 * then the ladder the live listing publishes, then the shipped snapshot, and
 * finally the per-vendor recommendation. Published metadata wins over the
 * recommendation because it is the relay's own vocabulary; the recommendation
 * only answers when the listing is silent, and is skipped when the caller
 * disabled the fallback.
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
  // The vendor profile is only a label source once real metadata exists, so it is
  // resolved unconditionally and consulted for its default later.
  const profile = vendorReasoningProfile(id)
  if (configured?.reasoningEfforts?.length) {
    const declared = configured.reasoningEfforts
    const published = discoveredLadder(discovered) ?? builtinLadder(builtin)
    // A declared ladder may name levels the vendor profile does not know, so the
    // default has to appear in the declared list to be legal.
    const configuredDefault = configured.defaultReasoningEffort ?? published?.defaultEffort
    const defaultEffort = configuredDefault !== undefined && declared.includes(configuredDefault)
      ? configuredDefault
      : profile !== undefined && declared.includes(profile.defaultEffort)
        ? profile.defaultEffort
        : undefined
    return ladderInfo(declared, defaultEffort, profile)
  }
  const published = discoveredLadder(discovered) ?? builtinLadder(builtin)
  if (published !== undefined) {
    // An empty ladder is the listing's "nothing selectable" answer: no picker and
    // no guessed default.
    if (published.efforts.length === 0) return undefined
    // `native` names no level, so fall back to the vendor default when the
    // listing still offers it, keeping a concrete selection in the picker.
    const defaultEffort = defaultEffortFor(published.efforts, published.defaultEffort, profile?.defaultEffort)
    return ladderInfo(published.efforts, defaultEffort, profile)
  }
  if (options.reasoningDefaults === false || profile === undefined) return undefined
  return ladderInfo(profile.efforts.map((effort) => effort.id), profile.defaultEffort, profile)
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
