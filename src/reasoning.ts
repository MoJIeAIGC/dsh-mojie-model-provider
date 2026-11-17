/**
 * Vendor thinking profiles for the Mojie route.
 *
 * DSH exposes exactly one thinking knob: `GenerateOptions.reasoningEffort`, an
 * opaque adapter-owned id. `resolveModel()` publishes the selectable ids through
 * `reasoning.efforts` (ordered from least to greatest), and the runtime
 * materializes `reasoning.defaultEffort` when a caller omits one. The id itself
 * means nothing to the harness, so this module owns the vocabulary and the
 * adapter sends each id verbatim as the Responses field `reasoning.effort`.
 *
 * `/v1/models` now publishes the real vocabulary per model: `reasoning.levels`
 * lists the selectable ids, `reasoning.can_disable` says whether `none` is
 * accepted, and `reasoning.default` names the site's own default (`native` when
 * the provider default applies). The adapter publishes exactly that ladder. The
 * per-vendor table below stays as the fallback for rows that publish no
 * metadata (older mirrors, self-hosted relays, ids added between syncs), so the
 * first request of a session still has a picker when the listing is silent.
 */

/** One selectable thinking level, published to DSH selectors. */
export interface ReasoningRung {
  /** Opaque id sent verbatim as the Responses `reasoning.effort` value. */
  readonly id: string
  /** Selector label. */
  readonly name: string
  /** One-line explanation of when this rung is worth picking. */
  readonly description: string
}

/** Recommended thinking ladder for one vendor family. */
export interface VendorReasoningProfile {
  /** Vendor family this ladder belongs to, for diagnostics and docs. */
  readonly vendor: string
  /** Levels from least to greatest effort, the order DSH requires. */
  readonly efforts: readonly ReasoningRung[]
  /** Level DSH materializes when the caller omits one. */
  readonly defaultEffort: string
}

const OFF: ReasoningRung = {
  id: 'none',
  name: 'Off',
  description: 'No deliberate thinking: fastest and cheapest, for formatting, extraction, and short lookups.',
}

const MINIMAL: ReasoningRung = {
  id: 'minimal',
  name: 'Minimal',
  description: 'Barely any deliberate thinking; OpenAI-only bottom rung for cheap tool-call loops.',
}

const LOW: ReasoningRung = {
  id: 'low',
  name: 'Low',
  description: 'Light thinking for small edits, single-file questions, and predictable tool calls.',
}

const MEDIUM: ReasoningRung = {
  id: 'medium',
  name: 'Medium',
  description: 'Balanced thinking; matches most vendors\' own default for everyday agent work.',
}

const HIGH: ReasoningRung = {
  id: 'high',
  name: 'High',
  description: 'Deep thinking for hard debugging, math, and multi-step planning; slowest and most expensive.',
}

const XHIGH: ReasoningRung = {
  id: 'xhigh',
  name: 'Extra high',
  description: 'Above high, for the hardest reasoning the model offers; noticeably slower and costlier.',
}

const MAX: ReasoningRung = {
  id: 'max',
  name: 'Max',
  description: 'The top rung a model publishes: maximum deliberation, usually reserved for the hardest problems.',
}

/** Level metadata keyed by id, so a hand-written ladder still gets labels. */
const KNOWN_RUNGS: ReadonlyMap<string, ReasoningRung> = new Map(
  [OFF, MINIMAL, LOW, MEDIUM, HIGH, XHIGH, MAX].map((rung) => [rung.id, rung]),
)

/**
 * Selectable ids for one model, built from the thinking metadata the listing
 * publishes.
 *
 * `can_disable` adds `none` as the bottom rung because the site accepts it to
 * turn thinking off; `levels` keeps the site's own ascending order and drops
 * blanks and duplicates. A published ladder that names a level the plugin does
 * not know (a future `ultra`) is still selectable.
 * @param levels - `reasoning.levels` as published, when disclosed.
 * @param canDisable - `reasoning.can_disable` as published, when disclosed.
 * @returns effort ids from least to greatest effort.
 */
export function publishedEffortIds(
  levels: readonly string[] | undefined,
  canDisable: boolean | undefined,
): string[] {
  const ids: string[] = []
  if (canDisable === true) ids.push('none')
  for (const raw of levels ?? []) {
    const id = raw.trim()
    if (id.length > 0 && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * Translate the site's `reasoning.default` into a selectable id.
 *
 * `'off'` is the site's spelling for "thinking off" and maps to `none` when
 * that rung exists; any other value is kept only when the published ladder
 * contains it. `'native'` is not an id, so it yields nothing here.
 * @param raw - `reasoning.default` as published, when disclosed.
 * @param efforts - selectable ids for this model.
 * @returns the id the listing named, or undefined when it named none of them.
 */
export function publishedDefaultEffort(
  raw: string | undefined,
  efforts: readonly string[],
): string | undefined {
  if (raw === undefined) return undefined
  const id = raw === 'off' ? 'none' : raw
  return efforts.includes(id) ? id : undefined
}

/** Ladder the plugin prefers when nobody names a default and the vendor has none in the list. */
const PREFERRED_DEFAULT_EFFORT = 'medium'

/**
 * Choose the default effort for a published ladder.
 *
 * A named default wins; otherwise the vendor's own default is used when the
 * listing still offers it, then `medium`, and finally the first non-`none`
 * rung (so a model whose only options are `low`/`high` never defaults to
 * thinking off). `none` is the last resort only when it is the whole ladder.
 * @param efforts - selectable ids in ascending order.
 * @param named - default named by the listing, when it named a selectable id.
 * @param vendorDefault - default the vendor profile prefers.
 * @returns the id to materialize, or undefined for an empty ladder.
 */
export function defaultEffortFor(
  efforts: readonly string[],
  named?: string,
  vendorDefault?: string,
): string | undefined {
  if (named !== undefined && efforts.includes(named)) return named
  if (vendorDefault !== undefined && efforts.includes(vendorDefault)) return vendorDefault
  if (efforts.includes(PREFERRED_DEFAULT_EFFORT)) return PREFERRED_DEFAULT_EFFORT
  return efforts.find((id) => id !== 'none') ?? efforts[0]
}

/**
 * One vendor rule: a model-id pattern plus the ladder it recommends.
 *
 * Rules are checked in order. Only families the live `/v1/models` catalog
 * actually lists get a rule; anything else falls through to {@link GENERIC_EFFORTS}.
 */
interface VendorRule {
  readonly vendor: string
  readonly pattern: RegExp
  readonly efforts: readonly ReasoningRung[]
  readonly defaultEffort: string
}

/**
 * Recommendation table, checked top to bottom.
 *
 * The table tracks the gateway, not the industry: it holds exactly the nine
 * families the public listing carries (GPT, Claude, Gemini, Grok, GLM, Qwen,
 * Kimi, DeepSeek, Doubao). Families the catalog never lists — o1/o3/o4, GPT-4,
 * Mistral, Llama, … — are deliberately absent, so the table cannot claim
 * knowledge about models a user cannot select here. An id that matches no rule
 * still gets the generic ladder, which is this plugin's optimistic default.
 *
 * Defaults follow each vendor's own published default where it has one
 * (`medium` for OpenAI, Gemini, Qwen, GLM, Kimi, grok) and the model's only
 * meaningful setting where the knob is binary (`deepseek`: think or not). The
 * bottom rung is `none` wherever the vendor lets thinking be disabled, and
 * `minimal` is OpenAI-only because no other vendor documents that level.
 */
const VENDOR_RULES: readonly VendorRule[] = [
  { vendor: 'openai', pattern: /^(?:gpt-[5-9]|gpt-\d\d|chatgpt(?:-|$))/iu, efforts: [OFF, MINIMAL, LOW, MEDIUM, HIGH], defaultEffort: 'medium' },
  { vendor: 'anthropic', pattern: /^claude/iu, efforts: [OFF, LOW, MEDIUM, HIGH], defaultEffort: 'medium' },
  { vendor: 'google', pattern: /^gemini/iu, efforts: [OFF, LOW, MEDIUM, HIGH], defaultEffort: 'medium' },
  { vendor: 'xai', pattern: /^grok/iu, efforts: [OFF, LOW, MEDIUM, HIGH], defaultEffort: 'medium' },
  { vendor: 'zhipu', pattern: /^glm/iu, efforts: [OFF, LOW, MEDIUM, HIGH], defaultEffort: 'medium' },
  { vendor: 'alibaba', pattern: /^qwen/iu, efforts: [OFF, LOW, MEDIUM, HIGH], defaultEffort: 'medium' },
  { vendor: 'moonshot', pattern: /^kimi/iu, efforts: [OFF, LOW, MEDIUM, HIGH], defaultEffort: 'medium' },
  // DeepSeek's thinking is a mode switch, not a scale: offer the two real states.
  { vendor: 'deepseek', pattern: /^deepseek/iu, efforts: [OFF, HIGH], defaultEffort: 'high' },
  { vendor: 'bytedance', pattern: /^(?:doubao|seed(?:-|$))/iu, efforts: [OFF, LOW, MEDIUM, HIGH], defaultEffort: 'medium' },
]

/** Ladder applied when no vendor rule matches: every level a relay may know. */
const GENERIC_EFFORTS: readonly ReasoningRung[] = [OFF, LOW, MEDIUM, HIGH]

/**
 * Recommend the thinking ladder for one model id.
 *
 * Matching is case-insensitive and purely lexical over the id, because the id is
 * the only family signal the gateway publishes. Ids the table does not know —
 * including families the site may add later — get the generic ladder, so a newly
 * listed model keeps a picker on its first request.
 * @param modelId - exact provider model id, e.g. `claude-opus-5.5`.
 * @returns the recommended ladder, or `undefined` for an empty id.
 */
export function vendorReasoningProfile(modelId: string): VendorReasoningProfile | undefined {
  const id = modelId.trim()
  if (id.length === 0) return undefined
  for (const rule of VENDOR_RULES) {
    if (!rule.pattern.test(id)) continue
    return { vendor: rule.vendor, efforts: rule.efforts, defaultEffort: rule.defaultEffort }
  }
  return { vendor: 'generic', efforts: GENERIC_EFFORTS, defaultEffort: 'medium' }
}

/**
 * Turn effort ids into selector metadata.
 *
 * A configured ladder may name levels the vendor profile does not (`turbo`,
 * `xhigh`, a renamed tier); those keep the id as both label and explanation
 * instead of being dropped.
 * @param ids - effort ids in the order the deployment declared them.
 * @param profile - vendor profile that supplies labels when ids overlap.
 * @returns rungs ready for `LlmModelReasoningInfo.efforts`.
 */
export function describeEfforts(
  ids: readonly string[],
  profile?: VendorReasoningProfile,
): ReasoningRung[] {
  return ids.map((id) => {
    const known = profile?.efforts.find((rung) => rung.id === id) ?? KNOWN_RUNGS.get(id)
    return known ?? { id, name: id, description: `Custom thinking level "${id}" supplied by the Mojie configuration.` }
  })
}
