/**
 * Advanced ("pass-through") image parameters and the per-model support table
 * that keeps one model's parameter from being sent with another model.
 *
 * The public set — `model` / `prompt` / `resolution` / `aspect_ratio` /
 * `input_image_urls` — works on every image model. The parameters here are
 * model-specific extensions the vendor documents separately. The gateway does
 * not reject an unsupported combination while creating the task: it accepts the
 * request, then fails (or silently ignores the field) upstream. Validating here
 * fails before a task exists, so a wrong combination costs nothing.
 *
 * Source of truth for the table below (update it when the vendor doc changes):
 * {@link IMAGE_PARAMETER_DOC_URL}.
 *
 * @module @mojieai/dsh-mojie-model-provider/media/parameters
 */

/**
 * Vendor "Image Generation" API doc, whose 高级穿透参数 section is the reference
 * for every parameter in this module.
 */
export const IMAGE_PARAMETER_DOC_URL = 'https://www.mojieaigc.com/docs/84c92eb8-f0c1-4e66-935f-96d3a73715c6'

/** Advanced parameters one image task may carry, named as the tools name them. */
export interface AdvancedImageParameters {
  /** Deliberation budget for the models that expose one. */
  readonly thinkingLevel?: string
  /** Quality tier for the models that expose one. */
  readonly quality?: string
  /** Background handling: `auto`, `transparent`, or `opaque`. */
  readonly background?: string
  /** Explicit pixel width, for models that accept a custom size instead of `resolution`. */
  readonly width?: number
  /** Explicit pixel height, paired with {@link AdvancedImageParameters.width}. */
  readonly height?: number
  /** Sequential-image behaviour for the models that expose it. */
  readonly sequentialImageGeneration?: string
}

/** Advanced parameters whose value is a string enum. */
type StringAdvancedProperty = 'thinkingLevel' | 'quality' | 'background' | 'sequentialImageGeneration'

/** One string-valued advanced parameter: wire name, accepted values, and doc label. */
interface StringParameterRule {
  /** Tool-facing property name. */
  readonly property: StringAdvancedProperty
  /** Provider request field. */
  readonly wire: string
  /** Accepted values on this model, or `undefined` when the model documents no such parameter. */
  readonly values: (normalizedModel: string) => readonly string[] | undefined
  /** Model label used in errors, mirroring the vendor doc. */
  readonly models: string
}

const QUALITY_CORE = ['auto', 'low', 'medium', 'high'] as const
const QUALITY_EXTENDED = ['auto', 'low', 'medium', 'high', 'max'] as const
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const
const BACKGROUNDS = ['auto', 'transparent', 'opaque'] as const
const SEQUENTIAL = ['disabled', 'auto'] as const

/** Smallest accepted custom side, in pixels. */
const MIN_SIDE = 16
/** Largest accepted custom side, in pixels. */
const MAX_SIDE = 8192

/**
 * Model families that accept `width` / `height`, mirroring the vendor doc.
 * The doc spells them `flux-2-pro` / `Qwen-image-3.0`; ids are matched after
 * normalization, so the live spellings (`flux2-pro`, `qwen-image-3`) match too.
 */
const CUSTOM_SIZE_MODELS = 'flux-2-pro / seedream-5-image / Qwen-image-3.0'

/** Documented string parameters and the models that implement each one. */
const STRING_RULES: readonly StringParameterRule[] = [
  {
    property: 'thinkingLevel',
    wire: 'thinking_level',
    values: (model) => model.startsWith('mojienanobanana2') || model.startsWith('mojienanobananapro')
      ? THINKING_LEVELS
      : undefined,
    models: 'Mojie-Nanobanana-2 / Mojie-Nanobanana-pro',
  },
  {
    property: 'quality',
    wire: 'quality',
    // The 2.5 family accepts one more tier than the base image model.
    values: (model) => model.startsWith('mojieimage25')
      ? QUALITY_EXTENDED
      : model.startsWith('mojieimage2') ? QUALITY_CORE : undefined,
    models: 'Mojie-image-2 / mojie-image-2-5-sunburst / mojie-image-2-5-flare',
  },
  {
    property: 'background',
    wire: 'background',
    values: (model) => model.startsWith('mojieimage25') ? BACKGROUNDS : undefined,
    models: 'mojie-image-2-5-sunburst / mojie-image-2-5-flare',
  },
  {
    property: 'sequentialImageGeneration',
    wire: 'sequential_image_generation',
    values: (model) => model.startsWith('seedream5image') ? SEQUENTIAL : undefined,
    models: 'seedream-5-image',
  },
]

/**
 * Canonical comparison form of a model id.
 *
 * Model ids differ between the vendor doc and the live listing by case, separator
 * style, and a trailing `.0` version (`Qwen-image-3.0` vs `qwen-image-3`), so the
 * support table matches on this form rather than on the raw string.
 * @param model - model id as configured or returned by `/v1/media/models`.
 * @returns lower-case id without separators or a trailing `.0`.
 */
export function normalizeImageModelId(model: string): string {
  return model.trim().toLowerCase().replace(/\.0+$/u, '').replace(/[\s_-]+/gu, '')
}

/** Whether this model accepts an explicit `width` / `height`. */
function supportsCustomSize(model: string): boolean {
  return model.startsWith('flux2pro') || model.startsWith('seedream5image') || model.startsWith('qwenimage3')
}

/**
 * One-line description of the advanced parameters a model accepts.
 *
 * Used by the model-listing tool so a caller can check support before adding a
 * parameter to a call; an empty string means the model documents none.
 * @param model - model id.
 * @returns comma-free summary such as ``quality: auto/low/medium/high``.
 */
export function advancedParameterSummary(model: string): string {
  const id = normalizeImageModelId(model)
  const parts: string[] = []
  for (const rule of STRING_RULES) {
    const values = rule.values(id)
    if (values !== undefined) parts.push(`${rule.wire}: ${values.join('/')}`)
  }
  if (supportsCustomSize(id)) parts.push(`width/height: ${MIN_SIDE}-${MAX_SIDE}px`)
  return parts.join(', ')
}

/**
 * Reject an advanced parameter that this model does not document, or a value
 * outside the documented set.
 *
 * The message names the accepted values and the doc, because it is shown to the
 * model that made the call: the fix is to drop the parameter, change the value,
 * or choose another model — not to retry blindly.
 * @param model - resolved image model id for the call.
 * @param input - advanced parameters the caller supplied.
 * @throws {Error} when a parameter is unsupported or a value is out of range.
 */
export function assertAdvancedParameters(model: string, input: AdvancedImageParameters): void {
  const normalized = normalizeImageModelId(model)
  for (const rule of STRING_RULES) {
    const value = input[rule.property]
    if (value === undefined) continue
    const accepted = rule.values(normalized)
    if (accepted === undefined) {
      throw new Error(
        `"${rule.wire}" is a model-specific advanced parameter and model "${model}" does not document it; `
        + `it applies to ${rule.models}. Omit "${rule.wire}" or choose one of those models. `
        + `Parameter reference: ${IMAGE_PARAMETER_DOC_URL}`,
      )
    }
    if (!accepted.includes(value)) {
      throw new Error(
        `"${rule.wire}"="${value}" is not documented for model "${model}"; `
        + `accepted values: ${accepted.join(' / ')}. `
        + `Parameter reference: ${IMAGE_PARAMETER_DOC_URL}`,
      )
    }
  }
  if (input.width !== undefined) assertSide('width', input.width, normalized, model)
  if (input.height !== undefined) assertSide('height', input.height, normalized, model)
}

/** Check one custom side against the model family and the pixel range. */
function assertSide(name: 'width' | 'height', value: number, normalized: string, model: string): void {
  if (!supportsCustomSize(normalized)) {
    throw new Error(
      `"${name}" is a model-specific advanced parameter and model "${model}" does not document it; `
      + `custom pixel sizes apply to ${CUSTOM_SIZE_MODELS}. Omit "${name}" or choose one of those models. `
      + `Parameter reference: ${IMAGE_PARAMETER_DOC_URL}`,
    )
  }
  if (!Number.isInteger(value) || value < MIN_SIDE || value > MAX_SIDE) {
    throw new Error(
      `"${name}"=${String(value)} must be an integer between ${MIN_SIDE} and ${MAX_SIDE} pixels. `
      + `Parameter reference: ${IMAGE_PARAMETER_DOC_URL}`,
    )
  }
}

/**
 * Project the advanced parameters onto provider request fields, omitting the
 * ones the caller did not set so the gateway keeps its own defaults.
 * @param input - advanced parameters, already validated.
 * @returns request fields keyed the way `POST /v1/media` expects them.
 */
export function advancedParameterPayload(input: AdvancedImageParameters): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  const wire: ReadonlyArray<readonly [StringAdvancedProperty, string]> = [
    ['thinkingLevel', 'thinking_level'],
    ['quality', 'quality'],
    ['background', 'background'],
    ['sequentialImageGeneration', 'sequential_image_generation'],
  ]
  for (const [property, field] of wire) {
    const value = input[property]
    if (value !== undefined) payload[field] = value
  }
  if (input.width !== undefined) payload.width = input.width
  if (input.height !== undefined) payload.height = input.height
  return payload
}
