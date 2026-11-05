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
 * The site publishes no effort vocabulary: `/v1/models` only reports
 * `supports_reasoning: true | false`. The plugin therefore recommends a ladder
 * per vendor and applies it without waiting for upstream confirmation. The
 * parameter is always sent for a reasoning-capable model; a rejection is treated
 * as an upstream bug (surfaced as `INVALID_REQUEST`) rather than a reason to
 * silently drop the parameter and retry.
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

/** Level metadata keyed by id, so a hand-written ladder still gets labels. */
const KNOWN_RUNGS: ReadonlyMap<string, ReasoningRung> = new Map(
  [OFF, MINIMAL, LOW, MEDIUM, HIGH].map((rung) => [rung.id, rung]),
)

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
