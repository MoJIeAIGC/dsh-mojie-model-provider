/**
 * Per-conversation image-model memory.
 *
 * A conversation should keep using the image model it already used unless the
 * user explicitly changes it (by naming one in the request, or by changing the
 * configured default). The chosen model is otherwise a per-call decision the
 * model could silently flip; remembering it here keeps successive generations
 * consistent across the native tools and `/image`.
 *
 * The memory is keyed by the calling Agent, held weakly, and invalidated when
 * the configured default changes — so a Settings edit or `/image model` takes
 * effect on the next call instead of being shadowed by the old choice.
 *
 * @module @deepseek-ai/dsh-mojie-model-provider/media/model-memory
 */

/** One conversation's last used image model, with the default it was chosen under. */
export interface RememberedModel {
  readonly model: string
  /** Configured default at the time of the choice; a change invalidates the memory. */
  readonly configuredDefault: string
}

const memory = new WeakMap<object, RememberedModel>()

/**
 * Record the image model this conversation just used.
 * @param agent - the calling Agent (the conversation identity).
 * @param model - the model that was actually requested.
 * @param configuredDefault - the default in force for that request.
 */
export function rememberImageModel(agent: unknown, model: string, configuredDefault: string): void {
  if (typeof agent !== 'object' || agent === null) return
  memory.set(agent, { model, configuredDefault })
}

/**
 * Recall the model this conversation used, when the default has not changed.
 * @param agent - the calling Agent.
 * @param configuredDefault - the default in force for the new request.
 * @returns the remembered model, or undefined when there is none or it is stale.
 */
export function recallImageModel(agent: unknown, configuredDefault: string): string | undefined {
  if (typeof agent !== 'object' || agent === null) return undefined
  const remembered = memory.get(agent)
  if (remembered === undefined) return undefined
  return remembered.configuredDefault === configuredDefault ? remembered.model : undefined
}

/**
 * Resolve and record the image model for one request.
 *
 * An explicit request wins and becomes the conversation's choice. An omitted
 * model reuses the remembered model unless the configured default changed since
 * it was chosen; then the new default wins. One conversation therefore stays on
 * one model without shadowing a deliberate Settings change.
 * @param agent - the calling Agent (conversation identity).
 * @param requested - the caller-supplied model, if any.
 * @param configuredDefault - the live configured default.
 * @returns the model id to request.
 */
export function chooseImageModel(agent: unknown, requested: string | undefined, configuredDefault: string): string {
  const explicit = requested?.trim()
  if (explicit !== undefined && explicit !== '') {
    rememberImageModel(agent, explicit, configuredDefault)
    return explicit
  }
  const remembered = recallImageModel(agent, configuredDefault)
  const model = remembered ?? configuredDefault
  rememberImageModel(agent, model, configuredDefault)
  return model
}
