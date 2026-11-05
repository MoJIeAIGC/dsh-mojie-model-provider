/**
 * Catalog and thinking metadata for the browser half.
 *
 * The Models page drafts model rows in the browser, but the merge rules and the
 * per-vendor thinking ladder live in the provider. This module is the client
 * mirror: it imports the same framework-free source (`catalog.generated.ts`,
 * `reasoning.ts`) the adapter resolves with, so a shipped snapshot and the
 * vendor recommendation auto-fill the card without any extra wire field.
 * @module @mojieai/dsh-mojie-model-provider/client/catalog-data
 */

import { BUILTIN_CATALOG_MODELS } from '../catalog.generated.ts'
import { sortModelOrder } from '../order.ts'
import { describeEfforts, vendorReasoningProfile } from '../reasoning.ts'

/** Display order of the effort vocabulary the provider knows. */
export const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high']

/** Snapshot lookup, so an offline card still shows capacities and image input. */
const BUILTIN = new Map(BUILTIN_CATALOG_MODELS.map((model) => [model.id, model]))

/**
 * Built-in metadata for one exact model id.
 * @param id - model id.
 * @returns the snapshot row when known.
 */
export function builtinModel(id) {
  return BUILTIN.get(id)
}

/**
 * Vendor-recommended thinking ladder for one model id, as plain rows.
 * @param id - model id.
 * @returns the recommendation, or `undefined` for an empty id.
 */
export function autoReasoning(id) {
  const profile = vendorReasoningProfile(typeof id === 'string' ? id : '')
  if (profile === undefined) return undefined
  return {
    vendor: profile.vendor,
    efforts: profile.efforts.map((rung) => ({ id: rung.id, name: rung.name, description: rung.description })),
    defaultEffort: profile.defaultEffort,
  }
}

/**
 * Read a hand-written ladder from a model row.
 * @param model - draft row.
 * @returns the declared ids, or `undefined` when the row declares none.
 */
export function declaredEfforts(model) {
  const value = model?.reasoningEfforts
  if (!Array.isArray(value) || value.length === 0) return undefined
  return value.filter((id) => typeof id === 'string' && id.trim().length > 0)
}

/**
 * The effort ids DSH will actually publish for one row.
 *
 * Mirrors the adapter: an explicit opt-out wins, then a declared ladder
 * (configuration, then the snapshot), then the vendor recommendation.
 * @param model - draft row.
 * @returns the effective ladder plus where it came from.
 */
export function effectiveReasoning(model) {
  const id = typeof model?.id === 'string' ? model.id.trim() : ''
  if (model?.reasoning === 'off') return undefined
  const profile = autoReasoning(id)
  const declared = declaredEfforts(model) ?? declaredEfforts(builtinModel(id))
  if (declared !== undefined) {
    const configuredDefault = model?.defaultReasoningEffort ?? builtinModel(id)?.defaultReasoningEffort
    const defaultEffort = typeof configuredDefault === 'string' && declared.includes(configuredDefault)
      ? configuredDefault
      : profile !== undefined && declared.includes(profile.defaultEffort)
        ? profile.defaultEffort
        : undefined
    const rungs = describeEfforts(declared, profile)
    return {
      source: 'declared',
      vendor: profile?.vendor,
      efforts: rungs.map((rung) => ({ id: rung.id, name: rung.name, description: rung.description })),
      ...defaultEffort === undefined ? {} : { defaultEffort },
    }
  }
  if (profile === undefined) return undefined
  return { source: 'auto', ...profile }
}

/**
 * How the card should present one row's thinking control.
 * @param model - draft row.
 * @returns `'off'`, `'custom'`, or `'auto'`.
 */
export function reasoningMode(model) {
  if (model?.reasoning === 'off') return 'off'
  return declaredEfforts(model) === undefined ? 'auto' : 'custom'
}

/**
 * The value a row would carry for one capacity field once materialized.
 * @param model - draft row.
 * @param field - `contextWindow` or `maxTokens`.
 * @param meta - merged discovery/snapshot metadata for this id, when known.
 * @returns the effective number, when any layer knows it.
 */
export function effectiveCapacity(model, field, meta) {
  const own = model?.[field]
  if (typeof own === 'number' && Number.isFinite(own) && own > 0) return own
  const value = meta?.[field]
  return typeof value === 'number' && value > 0 ? value : undefined
}

/**
 * The value a row would carry for input modalities once materialized.
 * @param model - draft row.
 * @param meta - merged discovery/snapshot metadata for this id, when known.
 * @returns the effective modalities, defaulting to text.
 */
export function effectiveModalities(model, meta) {
  const own = model?.inputModalities
  if (Array.isArray(own) && own.length > 0) return own
  const value = meta?.inputModalities
  if (Array.isArray(value) && value.length > 0) return value
  return ['text']
}

/**
 * One candidate model the fetch dialog can offer, merged from live discovery
 * and the shipped snapshot.
 *
 * The result uses the same display order as the composer (name, then id), so
 * the dialog, the card's inherited list and the chat picker agree.
 * @param discovered - live `/v1/models` rows, when the endpoint answered.
 * @returns candidates in selector order.
 */
export function catalogCandidates(discovered) {
  const rows = []
  const seen = new Set()
  for (const model of Array.isArray(discovered) ? discovered : []) {
    if (typeof model?.id !== 'string' || model.id.length === 0 || seen.has(model.id)) continue
    seen.add(model.id)
    rows.push(candidateRow(model, model))
  }
  for (const model of BUILTIN_CATALOG_MODELS) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    rows.push(candidateRow(undefined, model))
  }
  return sortModelOrder(rows)
}

/**
 * Merge one live row over its snapshot twin.
 * @param discovered - live row when known.
 * @param builtin - snapshot row when known.
 * @returns the candidate with the strongest disclosed metadata.
 */
function candidateRow(discovered, builtin) {
  const id = discovered?.id ?? builtin?.id
  const name = discovered?.name ?? builtin?.name ?? id
  const contextWindow = discovered?.contextWindow ?? builtin?.contextWindow
  const maxTokens = discovered?.maxTokens ?? builtin?.maxTokens
  const inputModalities = discovered?.inputModalities?.length
    ? discovered.inputModalities
    : builtin?.inputModalities?.length
      ? builtin.inputModalities
      : undefined
  return {
    id,
    name,
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...inputModalities === undefined ? {} : { inputModalities: [...inputModalities] },
  }
}

/**
 * Rows the card shows while the model list is inherited (the adapter default).
 *
 * This is the auto-filled "model catalog": everything the live listing and the
 * shipped snapshot know, with capacities and input types already populated.
 * @param discovered - live `/v1/models` rows.
 * @returns draft rows carrying the disclosed metadata.
 */
export function inheritedRows(discovered) {
  return catalogCandidates(discovered).map((candidate) => ({
    id: candidate.id,
    ...candidate.name === undefined || candidate.name === candidate.id ? {} : { name: candidate.name },
    ...candidate.contextWindow === undefined ? {} : { contextWindow: candidate.contextWindow },
    ...candidate.maxTokens === undefined ? {} : { maxTokens: candidate.maxTokens },
    ...candidate.inputModalities === undefined ? {} : { inputModalities: [...candidate.inputModalities] },
  }))
}

/**
 * Adopt one candidate into a configured model row, as the native Models page
 * does: id, display name, capacities, and disclosed input types.
 * @param candidate - one fetch-dialog candidate.
 * @returns the configured row to append.
 */
export function adoptCandidate(candidate) {
  return {
    id: candidate.id,
    ...candidate.name === undefined || candidate.name === candidate.id ? {} : { name: candidate.name },
    ...candidate.contextWindow === undefined ? {} : { contextWindow: candidate.contextWindow },
    ...candidate.maxTokens === undefined ? {} : { maxTokens: candidate.maxTokens },
    ...candidate.inputModalities === undefined ? {} : { inputModalities: [...candidate.inputModalities] },
  }
}

/**
 * Parse a capacity field, accepting the decimal `K`/`M` suffixes the native
 * editor accepts. An empty field means "inherit".
 * @param text - raw input text.
 * @returns the number, `undefined` for an empty field, or `NaN` when invalid.
 */
export function parseCapacity(text) {
  const value = String(text ?? '').trim()
  if (value.length === 0) return undefined
  const match = /^(\d+(?:\.\d+)?)\s*([KkMm])?$/u.exec(value)
  if (match === null) return Number.NaN
  const base = Number(match[1])
  const suffix = match[2]?.toLowerCase()
  const scaled = suffix === 'k' ? base * 1_000 : suffix === 'm' ? base * 1_000_000 : base
  return Number.isFinite(scaled) && scaled > 0 ? Math.round(scaled) : Number.NaN
}

/**
 * Render a capacity with the same decimal suffixes.
 * @param value - token count.
 * @returns the input text.
 */
export function formatCapacity(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return ''
  if (value >= 1_000_000 && value % 100_000 === 0) return `${value / 1_000_000}M`
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}K`
  return String(value)
}

/**
 * Stamp one draft row back into a settings-shaped model row.
 *
 * Unknown fields come from the row's stored original, so a save never drops a
 * field the card does not display (`description`, `systemPromptUpdate`, …).
 * @param row - draft row.
 * @returns the settings row.
 */
export function modelConfigFromRow(row) {
  const next = { ...(row?._original ?? {}) }
  next.id = typeof row?.id === 'string' ? row.id.trim() : ''
  for (const key of [
    'name',
    'contextWindow',
    'maxTokens',
    'inputModalities',
    'reasoningEfforts',
    'defaultReasoningEffort',
  ]) {
    const value = row?.[key]
    // The settings schema materializes absent arrays as `[]`; an empty list
    // declares nothing, so never write one back.
    if (value === undefined || Array.isArray(value) && value.length === 0) delete next[key]
    else next[key] = value
  }
  if (row?.reasoning === 'off') {
    next.reasoning = 'off'
    delete next.reasoningEfforts
    delete next.defaultReasoningEffort
  } else {
    delete next.reasoning
  }
  return next
}

/**
 * Apply one fetch-dialog selection to the current rows, exactly like the page's
 * native “更新列表”: unchecked listed models are removed, checked candidates
 * that are not already present are appended with their disclosed metadata.
 * The merged list is returned in selector order.
 * @param rows - current draft rows.
 * @param candidates - dialog candidates.
 * @param isPicked - selection predicate for one candidate id.
 * @returns the merged rows.
 */
export function mergePickedModels(rows, candidates, isPicked) {
  const listed = new Set(candidates.map((candidate) => candidate.id))
  const keptRows = rows.filter((row) => !(listed.has(row.id) && !isPicked(row.id)))
  const keptIds = new Set(keptRows.map((row) => row.id))
  const addedRows = candidates.filter((candidate) => isPicked(candidate.id) && !keptIds.has(candidate.id)).map(adoptCandidate)
  return sortModelOrder([...keptRows, ...addedRows])
}
