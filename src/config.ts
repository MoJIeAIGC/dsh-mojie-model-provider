import type { Volatile } from '@deepseek-ai/cordis'
import { isVolatile } from '@deepseek-ai/cosmokit'
import z from '@deepseek-ai/schemastery'
import { LlmError, type ModelModality, type SystemPromptUpdate } from '@deepseek-ai/dsh-llm'
import { normalizeBaseURL } from './core/endpoint.js'

/**
 * One explicitly configured Mojie model entry.
 */
export interface MojieModelConfig {
  /** Exact provider model id. */
  id: string
  /** Human-readable display name. */
  name?: string
  /** Optional selector description. */
  description?: string
  /** Maximum combined context window when known. */
  contextWindow?: number
  /** Default output cap when known. */
  maxTokens?: number
  /** Accepted input modalities when known. */
  inputModalities?: ModelModality[]
  /** Selectable reasoning efforts when this model exposes them. */
  reasoningEfforts?: string[]
  /** Default reasoning effort when callers omit one. */
  defaultReasoningEffort?: string
  /** Mid-conversation system prompt mode when confirmed. */
  systemPromptUpdate?: SystemPromptUpdate
}

/**
 * Live deployment configuration for the Mojie provider plugin.
 *
 * Every field is a stable volatile reference: settings surfaces can edit it
 * without remounting the plugin, and each request reads the current value.
 */
export interface Config {
  /** Credential reference resolved through the credentials seam or the environment. */
  apiKeyEnv: Volatile<string>
  /** Site root used to build `/v1/models` and `/v1/Responses`. */
  baseURL: Volatile<string>
  /** Advisory model metadata and overrides. */
  models: Volatile<MojieModelConfig[]>
  /**
   * Time allowed from sending the request until the response headers arrive.
   * Covers connect, TLS, upload, and upstream queueing: a gateway that keeps the
   * connection open without answering is cut here instead of hanging forever.
   */
  firstByteTimeoutMs: Volatile<number>
  /**
   * Maximum silence between received bytes. Any traffic resets it, including
   * SSE comment heartbeats, so a long generation that keeps streaming is never
   * aborted no matter how long it takes.
   */
  streamIdleTimeoutMs: Volatile<number>
  /**
   * Optional hard cap on the whole exchange, for operational backstops only
   * (`0` disables it). Never the liveness judge: a live stream is bounded by
   * {@link firstByteTimeoutMs} and {@link streamIdleTimeoutMs}.
   */
  requestTimeoutMs: Volatile<number>
  /** Aggregate base64 image payload budget for one request. */
  maxRequestImageBytes: Volatile<number>
  /** Total pixel budget for one derived request image. */
  requestImagePixelBudget: Volatile<number>
  /** Encoded byte target for one derived request image. */
  requestImageMaxBytes: Volatile<number>
  /** Register the native `/v1/media` image tools (`mojie_generate_image`, …). */
  imageTools: Volatile<boolean>
  /** Default image model when a call omits one. */
  imageDefaultModel: Volatile<string>
  /** Default image resolution when a call omits one (provider vocabulary, e.g. `1K`). */
  imageDefaultResolution: Volatile<string>
  /** Default aspect ratio when a call omits one (e.g. `1:1`). */
  imageDefaultAspectRatio: Volatile<string>
  /** Delay between `/v1/media/tasks/{id}` polls. */
  imagePollIntervalMs: Volatile<number>
  /** How long one tool call waits inline before handing the task id back. */
  imageTaskTimeoutMs: Volatile<number>
  /** Byte cap for downloading one generated image into attachments. */
  imageDownloadMaxBytes: Volatile<number>
}

/** Plain values accepted by the resolver. */
export type Options = {
  [K in keyof Config]?: Config[K] extends Volatile<infer T> ? Exclude<T, undefined> : never
}

/** Built-in image model used when the deployment configures none. */
export const DEFAULT_IMAGE_MODEL = 'seedream-5-image'

/** Fully defaulted plain configuration used by one request operation. */
export interface ResolvedConfig {
  apiKeyEnv: string
  baseURL: string
  models: MojieModelConfig[]
  firstByteTimeoutMs: number
  streamIdleTimeoutMs: number
  requestTimeoutMs: number
  maxRequestImageBytes: number
  requestImagePixelBudget: number
  requestImageMaxBytes: number
  imageTools: boolean
  imageDefaultModel: string
  imageDefaultResolution: string
  imageDefaultAspectRatio: string
  imagePollIntervalMs: number
  imageTaskTimeoutMs: number
  imageDownloadMaxBytes: number
}

/**
 * Read the current value behind every volatile reference of a parsed Config.
 * @param config - parsed plugin configuration.
 * @returns plain options for the resolver.
 */
export function plainOptions(config: Config): ResolvedConfig {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [
    key,
    isVolatile(value) ? value.get() : value,
  ])) as unknown as ResolvedConfig
}

const modalitySchema = z.union(['text', 'image'])

const reasoningEffortSchema = z.string()

const modelSchema: z<MojieModelConfig> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().min(1),
  maxTokens: z.number().min(1),
  inputModalities: z.array(modalitySchema),
  reasoningEfforts: z.array(reasoningEffortSchema),
  defaultReasoningEffort: reasoningEffortSchema,
  systemPromptUpdate: z.union(['in-history']),
})

/**
 * Schemastery configuration schema used by the plugin entry.
 *
 * Every field is volatile because the settings surfaces edit the running
 * profile without remounting the plugin: each request reads the live value.
 */
export const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default('MOJIE_API_KEY').volatile(),
  baseURL: z.string().default('https://www.mojieaigc.com').volatile(),
  models: z.array(modelSchema).default([]).volatile(),
  // Wait for response headers at most this long; a silent gateway fails fast.
  firstByteTimeoutMs: z.number().min(1).default(60_000).volatile(),
  // Silence between received bytes; SSE heartbeats count as activity. Long
  // generations are bounded by this, never by their total duration.
  streamIdleTimeoutMs: z.number().min(1).default(90_000).volatile(),
  // Operational backstop only: 0 disables it. Do not use as a liveness judge.
  requestTimeoutMs: z.number().min(0).default(0).volatile(),
  maxRequestImageBytes: z.number().min(1).default(20 * 1024 * 1024).volatile(),
  requestImagePixelBudget: z.number().min(1).default(1024 * 1024).volatile(),
  requestImageMaxBytes: z.number().min(1).default(2 * 1024 * 1024).volatile(),
  // Native image generation (`POST /v1/media`). The tools are registered only
  // while `ctx.tools` is mounted, and results are saved into attachments when
  // a durable store exists so the picture renders like a native one.
  imageTools: z.boolean().default(true).volatile(),
  imageDefaultModel: z.string().default(DEFAULT_IMAGE_MODEL).volatile(),
  imageDefaultResolution: z.string().default('1K').volatile(),
  imageDefaultAspectRatio: z.string().default('1:1').volatile(),
  imagePollIntervalMs: z.number().min(100).default(3_000).volatile(),
  imageTaskTimeoutMs: z.number().min(1_000).default(600_000).volatile(),
  imageDownloadMaxBytes: z.number().min(1).default(20 * 1024 * 1024).volatile(),
})

/**
 * Normalize Mojie configuration after schema validation.
 * @param config - validated plain configuration.
 * @returns normalized configuration.
 */
export function normalizeConfig(config: ResolvedConfig): ResolvedConfig {
  const baseURL = normalizeBaseURL(config.baseURL)
  const apiKeyEnv = config.apiKeyEnv.trim()
  if (apiKeyEnv.length === 0) throw new LlmError('mojie apiKeyEnv must be non-empty', 'INVALID_CONFIG')
  const models = config.models.map(normalizeModel)
  const imageDefaultModel = config.imageDefaultModel.trim()
  if (imageDefaultModel.length === 0) throw new LlmError('mojie imageDefaultModel must be non-empty', 'INVALID_CONFIG')
  return {
    ...config,
    baseURL,
    apiKeyEnv,
    models,
    imageDefaultModel,
    imageDefaultResolution: config.imageDefaultResolution.trim(),
    imageDefaultAspectRatio: config.imageDefaultAspectRatio.trim(),
  }
}

/**
 * Normalize one configured model entry.
 * @param model - validated model entry.
 * @returns normalized model entry.
 */
export function normalizeModel(model: MojieModelConfig): MojieModelConfig {
  const {
    inputModalities: rawInputModalities,
    reasoningEfforts: rawReasoningEfforts,
    defaultReasoningEffort: rawDefaultReasoningEffort,
    ...rest
  } = model
  const id = model.id.trim()
  if (id.length === 0) throw new LlmError('mojie model ids must be non-empty', 'INVALID_CONFIG')
  const name = model.name?.trim()
  const description = model.description?.trim()
  // Schemastery materializes an absent array as `[]`. An empty list means the
  // deployment declared no capability at all, so it must stay absent here and
  // let built-in or discovered metadata answer instead of overriding it.
  const inputModalities = rawInputModalities?.length === 0 ? undefined : rawInputModalities
  const reasoningEfforts = rawReasoningEfforts === undefined || rawReasoningEfforts.length === 0
    ? undefined
    : rawReasoningEfforts.map((effort) => {
      const value = effort.trim()
      if (value.length === 0) throw new LlmError(`mojie model "${id}" has an empty reasoning effort`, 'INVALID_CONFIG')
      return value
    })
  const defaultReasoningEffort = rawDefaultReasoningEffort?.trim()
  if (defaultReasoningEffort !== undefined) {
    if (defaultReasoningEffort.length === 0) {
      throw new LlmError(`mojie model "${id}" has an empty defaultReasoningEffort`, 'INVALID_CONFIG')
    }
    if (!reasoningEfforts?.includes(defaultReasoningEffort)) {
      throw new LlmError(`mojie model "${id}" defaultReasoningEffort must appear in reasoningEfforts`, 'INVALID_CONFIG')
    }
  }
  return {
    ...rest,
    id,
    ...name === undefined || name.length === 0 ? {} : { name },
    ...description === undefined || description.length === 0 ? {} : { description },
    ...inputModalities === undefined ? {} : { inputModalities },
    ...reasoningEfforts === undefined ? {} : { reasoningEfforts },
    ...defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort },
  }
}

// Endpoint helpers live in the framework-free core so standalone consumers can
// build URLs without this plugin's Schemastery config surface. Re-exported here
// to keep the provider's own import paths stable.
export { modelsURL, normalizeBaseURL, responsesURL } from './core/endpoint.js'
