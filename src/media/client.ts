import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { normalizeBaseURL } from '../core/endpoint.js'
import { providerError } from '../transport.js'
import { advancedParameterPayload, assertAdvancedParameters, type AdvancedImageParameters } from './parameters.js'

/**
 * Mojie `/v1/media` client: text-to-image and image-edit tasks plus the model
 * listing. It is deliberately framework-free, like {@link MojieClient}, so a
 * tool, a script, or another plugin can own the capability.
 *
 * @module @mojieai/dsh-mojie-model-provider/media
 */

/** One generated image as the task reported it. */
export interface MojieMediaImage {
  readonly url: string
  /** Provider media type (`image` today). */
  readonly mediaType?: string
  /** Mime type such as `image/png`. */
  readonly mimeType?: string
}

/** Normalized view of one `/v1/media/tasks/{id}` payload. */
export interface MojieMediaTask {
  readonly id: string
  readonly model?: string
  /** Provider status: `pending`, `processing`, `succeeded`, or `failed`. */
  readonly status: string
  readonly images: readonly MojieMediaImage[]
  /** Provider usage/report payload, when disclosed. */
  readonly usage?: unknown
  /** Provider failure text, when the task failed. */
  readonly error?: string
}

/**
 * Request body for one media task creation.
 *
 * Inherits the model-specific advanced parameters, which {@link MojieMediaClient.createTask}
 * validates against the target model before anything is sent.
 */
export interface MojieMediaRequest extends AdvancedImageParameters {
  /** Image model id from {@link MojieMediaClient.listModels}. */
  readonly model: string
  /** What to draw (or how to change `input_image`). */
  readonly prompt: string
  /** Provider resolution vocabulary, e.g. `1K`, `2K`. */
  readonly resolution?: string
  /** Provider aspect ratio, e.g. `1:1`, `16:9`. */
  readonly aspectRatio?: string
  /**
   * Reference images for an edit, in caller order: HTTPS URLs, `data:` URLs, or
   * local paths the gateway can read. The provider field is `input_image_urls`,
   * and a multi-image edit keeps this order.
   */
  readonly inputImages?: readonly string[]
  /** Provider-specific extras forwarded verbatim. */
  readonly extra?: Readonly<Record<string, unknown>>
}

/** Construction options for {@link MojieMediaClient}. */
export interface MojieMediaClientOptions {
  /** Mojie site root, or the same root with a trailing `/v1`. */
  readonly baseURL: string
  /** Raw API key. Never logged; passed only as a bearer header. */
  readonly apiKey: string
  /** Delay between task polls; defaults to 3s. */
  readonly pollIntervalMs?: number
  /** Inline wait before returning the pending task id; defaults to 10 minutes. */
  readonly taskTimeoutMs?: number
  /**
   * Live image-model blacklist provider.
   *
   * `listModels()` consults it on every call, so a configuration edit applies
   * to the next listing without reconstructing the client. Blacklisted models
   * are hidden from pickers; an explicitly requested id is still accepted,
   * because this is a selection policy rather than an authorization boundary.
   */
  readonly blockedImageModels?: () => readonly string[]
  /** Fetch implementation, injectable for tests. */
  readonly fetch?: typeof fetch
}

/** Marker the Settings card sends through model discovery to request image models. */
export const MEDIA_MODELS_DISCOVERY_API = 'mojie-media-models'

/** What a media model produces, as `GET /v1/media/models` declares it. */
export type MojieMediaOutputModality = 'image' | 'video'

/**
 * One row of `GET /v1/media/models`.
 *
 * The endpoint used to answer with bare id strings. It now answers with model
 * objects whose `architecture.output_modalities` distinguishes image models
 * from video models; both share the same listing and the same task endpoint,
 * so a caller that can only render images has to select by output kind.
 *
 * `outputModalities` is absent when a row declares nothing (legacy string rows,
 * or an older deployment of the endpoint). Such a row keeps the endpoint's
 * pre-classification meaning, which only served image models.
 */
export interface MojieMediaModel {
  readonly id: string
  /** Listing display name, when it differs from `id`. */
  readonly name?: string
  /** Declared output kinds; absent when the row did not declare any. */
  readonly outputModalities?: readonly MojieMediaOutputModality[]
}

/**
 * True when a media model can answer an image request.
 * @param model - normalized listing row.
 * @returns whether the model may be used for image generation or editing.
 */
export function isImageMediaModel(model: MojieMediaModel): boolean {
  return model.outputModalities === undefined || model.outputModalities.includes('image')
}

const SUPPORTED_IMAGE_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/**
 * Media gateway client for Mojie's asynchronous image tasks.
 */
export class MojieMediaClient {
  private readonly baseURL: string

  /**
   * @param options - endpoint, credential, and polling/download limits.
   * @throws {LlmError} `INVALID_CONFIG` for an unusable endpoint, `MISSING_CREDENTIAL` for an empty key.
   */
  constructor(private readonly options: MojieMediaClientOptions) {
    this.baseURL = normalizeBaseURL(options.baseURL)
    if (options.apiKey.trim().length === 0) {
      throw new LlmError('mojie media client requires a non-empty API key', 'MISSING_CREDENTIAL')
    }
  }

  /** `GET` target for the image model listing. */
  get modelsEndpoint(): string {
    return `${this.baseURL}/v1/media/models`
  }

  /** `POST` target for task creation. */
  get tasksEndpoint(): string {
    return `${this.baseURL}/v1/media`
  }

  /**
   * List every media model this key may call, with its declared output kinds.
   *
   * Both shapes the endpoint has shipped are accepted: the current model
   * objects (with `architecture.output_modalities`) and the legacy bare id
   * strings. Duplicate ids collapse to their first row.
   * @param signal - optional cancellation.
   * @returns normalized model rows in endpoint order.
   */
  async listMediaModels(signal?: AbortSignal): Promise<MojieMediaModel[]> {
    const body = await this.request('GET', this.modelsEndpoint, undefined, signal)
    const data = isRecord(body) ? body.data ?? body : undefined
    if (!Array.isArray(data)) throw new LlmError('Mojie /v1/media/models has no data array', 'MALFORMED_RESPONSE')
    const models: MojieMediaModel[] = []
    const seen = new Set<string>()
    for (const row of data) {
      const model = normalizeMediaModel(row)
      if (model === undefined || seen.has(model.id)) continue
      seen.add(model.id)
      models.push(model)
    }
    return models
  }

  /**
   * List the image models this key may call.
   *
   * Image and video models share one listing, so video-only rows are filtered
   * out here. The live blacklist is applied on top: every image tool and the
   * Settings dropdown would otherwise offer a model the deployment hid.
   * @param signal - optional cancellation.
   * @returns image model ids in endpoint order.
   */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const blocked = new Set(
      (this.options.blockedImageModels?.() ?? []).map((id) => id.trim().toLowerCase()),
    )
    return (await this.listMediaModels(signal))
      .filter(isImageMediaModel)
      .map((model) => model.id)
      .filter((id) => !blocked.has(id.toLowerCase()))
  }

  /**
   * Create one media task (no polling).
   *
   * Advanced parameters are checked against the resolved model first: the
   * gateway accepts an unsupported combination and only fails later, so a wrong
   * pairing is rejected here while no task exists.
   * @param request - model, prompt, and provider options.
   * @param signal - optional cancellation.
   * @returns the created task id and its initial status.
   * @throws {Error} when an advanced parameter does not belong to this model.
   */
  async createTask(request: MojieMediaRequest, signal?: AbortSignal): Promise<{ id: string; model?: string; status: string }> {
    assertAdvancedParameters(request.model, request)
    const payload = {
      model: request.model,
      prompt: request.prompt,
      ...request.resolution === undefined ? {} : { resolution: request.resolution },
      ...request.aspectRatio === undefined ? {} : { aspect_ratio: request.aspectRatio },
      ...request.inputImages === undefined || request.inputImages.length === 0
        ? {}
        : { input_image_urls: [...request.inputImages] },
      ...advancedParameterPayload(request),
      ...request.extra ?? {},
    }
    const body = await this.request('POST', this.tasksEndpoint, payload, signal)
    const record = isRecord(body) ? body : {}
    const id = typeof record.id === 'string' ? record.id : undefined
    if (id === undefined) throw new LlmError('Mojie /v1/media did not return a task id', 'MALFORMED_RESPONSE')
    return {
      id,
      status: typeof record.status === 'string' ? record.status : 'pending',
      ...typeof record.model === 'string' ? { model: record.model } : {},
    }
  }

  /**
   * Read one task's current state.
   * @param id - task id returned by {@link createTask}.
   * @param signal - optional cancellation.
   * @returns normalized task view.
   */
  async getTask(id: string, signal?: AbortSignal): Promise<MojieMediaTask> {
    const body = await this.request('GET', `${this.tasksEndpoint}/tasks/${encodeURIComponent(id)}`, undefined, signal)
    return normalizeTask(body, id)
  }

  /**
   * Create a task and wait for it to settle, within the configured inline window.
   * @param request - model, prompt, and provider options.
   * @param signal - optional cancellation.
   * @returns the settled task, or the still-running task once the window ends.
   * @throws {LlmError} `MEDIA_TASK_FAILED` when the provider reports a failure.
   */
  async generate(request: MojieMediaRequest, signal?: AbortSignal): Promise<MojieMediaTask> {
    const created = await this.createTask(request, signal)
    const pollIntervalMs = this.options.pollIntervalMs ?? 3_000
    const deadline = Date.now() + (this.options.taskTimeoutMs ?? 600_000)
    let task = await this.getTask(created.id, signal)
    while (task.status !== 'succeeded' && task.status !== 'failed' && Date.now() < deadline) {
      await delay(pollIntervalMs, signal)
      task = await this.getTask(created.id, signal)
    }
    if (task.status === 'failed') {
      throw new LlmError(
        `Mojie image task ${task.id} failed${task.error === undefined ? '' : `: ${task.error}`}`,
        'MEDIA_TASK_FAILED',
        { status: 502 },
      )
    }
    return { ...task, ...created.model === undefined ? {} : { model: created.model } }
  }

  /**
   * Download one generated image and verify its media type.
   *
   * There is deliberately no byte cap: the provider's original is the artifact
   * the user asked for, so a large image must still be saved. The caller decides
   * where it goes and what a display copy may do.
   * @param image - image entry from a settled task.
   * @param signal - optional cancellation.
   * @returns bytes and the sniffed/declared media type.
   * @throws {LlmError} `UNSUPPORTED_CONTENT` for a non-image result.
   */
  async download(image: MojieMediaImage, signal?: AbortSignal): Promise<{ data: Uint8Array; mediaType: ImageMediaType }> {
    const fetchImpl = this.options.fetch ?? fetch
    const response = await fetchImpl(image.url, {
      method: 'GET',
      ...signal === undefined ? {} : { signal },
    })
    if (!response.ok) {
      throw new LlmError(`could not download the generated image (${response.status})`, 'MEDIA_DOWNLOAD_FAILED', { status: response.status })
    }
    const data = new Uint8Array(await response.arrayBuffer())
    const sniffed = sniffImageMediaType(data)
    const declaredType = image.mimeType ?? response.headers.get('content-type')?.split(';')[0]?.trim()
    const mediaType = sniffed ?? (SUPPORTED_IMAGE_TYPES.find((type) => type === declaredType))
    if (mediaType === undefined) {
      throw new LlmError('generated media is not a PNG/JPEG/WebP/GIF image', 'UNSUPPORTED_CONTENT')
    }
    return { data, mediaType }
  }

  private async request(method: 'GET' | 'POST', url: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const fetchImpl = this.options.fetch ?? fetch
    let response: Response
    try {
      response = await fetchImpl(url, {
        method,
        ...signal === undefined ? {} : { signal },
        redirect: 'error',
        headers: {
          'accept': 'application/json',
          ...payload === undefined ? {} : { 'content-type': 'application/json' },
          'authorization': `Bearer ${this.options.apiKey}`,
        },
        ...payload === undefined ? {} : { body: JSON.stringify(payload) },
      })
    } catch (cause) {
      if (signal?.aborted) throw new LlmError('Mojie media request aborted', 'ABORTED', { cause: cause as Error })
      throw new LlmError('Mojie media transport failed', 'TRANSPORT', { cause: cause as Error })
    }
    let body: unknown
    const text = await response.text()
    try {
      body = text.length === 0 ? undefined : JSON.parse(text)
    } catch (cause) {
      if (!response.ok) throw providerError(undefined, response.status, response.headers)
      throw new LlmError('Mojie media endpoint did not answer with JSON', 'MALFORMED_RESPONSE', { cause: cause as Error })
    }
    if (!response.ok) throw providerError(body, response.status, response.headers)
    return body
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalize one `/v1/media/models` row.
 *
 * The current listing sends `{ id, name, architecture: { output_modalities } }`;
 * the legacy listing sent a bare id string and is still accepted so a pinned
 * gateway keeps working.
 */
function normalizeMediaModel(row: unknown): MojieMediaModel | undefined {
  if (typeof row === 'string') return row.length === 0 ? undefined : { id: row }
  if (!isRecord(row)) return undefined
  const id = typeof row.id === 'string' && row.id.length > 0 ? row.id : undefined
  if (id === undefined) return undefined
  const name = typeof row.name === 'string' && row.name.length > 0 && row.name !== id ? row.name : undefined
  const outputs = readOutputModalities(row)
  return {
    id,
    ...name === undefined ? {} : { name },
    ...outputs === undefined ? {} : { outputModalities: outputs },
  }
}

/** Read `architecture.output_modalities`, falling back to a top-level field. */
function readOutputModalities(row: Record<string, unknown>): MojieMediaOutputModality[] | undefined {
  const architecture = isRecord(row.architecture) ? row.architecture : undefined
  const raw = architecture?.output_modalities ?? row.output_modalities
  if (!Array.isArray(raw)) return undefined
  const known = raw.filter(
    (entry): entry is MojieMediaOutputModality => entry === 'image' || entry === 'video',
  )
  if (known.length === 0) return undefined
  return [...new Set(known)]
}

/** Normalize one task payload into its provider-independent view. */
function normalizeTask(body: unknown, fallbackId: string): MojieMediaTask {
  const record = isRecord(body) ? body : {}
  const data = Array.isArray(record.data) ? record.data : []
  const images: MojieMediaImage[] = []
  for (const item of data) {
    if (!isRecord(item) || typeof item.url !== 'string') continue
    if (item.media_type !== undefined && item.media_type !== 'image') continue
    images.push({
      url: item.url,
      ...typeof item.media_type === 'string' ? { mediaType: item.media_type } : {},
      ...typeof item.mime_type === 'string' ? { mimeType: item.mime_type } : {},
    })
  }
  const error = isRecord(record.error)
    ? typeof record.error.message === 'string' ? record.error.message : undefined
    : typeof record.error === 'string' ? record.error : undefined
  return {
    id: typeof record.id === 'string' ? record.id : fallbackId,
    ...typeof record.model === 'string' ? { model: record.model } : {},
    status: typeof record.status === 'string' ? record.status : 'unknown',
    images,
    ...record.usage === undefined ? {} : { usage: record.usage },
    ...error === undefined ? {} : { error },
  }
}

/** Identify a supported image type from its file signature. */
export function sniffImageMediaType(data: Uint8Array): ImageMediaType | undefined {
  const starts = (...bytes: number[]): boolean => bytes.every((byte, index) => data[index] === byte)
  const ascii = (offset: number, text: string): boolean => {
    if (data.byteLength < offset + text.length) return false
    for (let index = 0; index < text.length; index += 1) {
      if (data[offset + index] !== text.charCodeAt(index)) return false
    }
    return true
  }
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  return undefined
}

/** Wait, honoring caller cancellation. */
async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw new LlmError('Mojie media request aborted', 'ABORTED')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new LlmError('Mojie media request aborted', 'ABORTED'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
