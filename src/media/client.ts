import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { normalizeBaseURL } from '../core/endpoint.js'
import { providerError } from '../transport.js'

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

/** Request body for one media task creation. */
export interface MojieMediaRequest {
  /** Image model id from {@link MojieMediaClient.listModels}. */
  readonly model: string
  /** What to draw (or how to change `input_image`). */
  readonly prompt: string
  /** Provider resolution vocabulary, e.g. `1K`, `2K`. */
  readonly resolution?: string
  /** Provider aspect ratio, e.g. `1:1`, `16:9`. */
  readonly aspectRatio?: string
  /** Reference image for an edit: HTTPS URL, `data:` URL, or local path. */
  readonly inputImage?: string
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
  /** Byte cap for downloading one image; defaults to 20 MiB. */
  readonly downloadMaxBytes?: number
  /** Fetch implementation, injectable for tests. */
  readonly fetch?: typeof fetch
}

/** Marker the Settings card sends through model discovery to request image models. */
export const MEDIA_MODELS_DISCOVERY_API = 'mojie-media-models'

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
   * List the image models this key may call.
   * @param signal - optional cancellation.
   * @returns model ids in endpoint order.
   */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const body = await this.request('GET', this.modelsEndpoint, undefined, signal)
    const data = isRecord(body) ? body.data ?? body : undefined
    if (!Array.isArray(data)) throw new LlmError('Mojie /v1/media/models has no data array', 'MALFORMED_RESPONSE')
    return data.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  }

  /**
   * Create one media task (no polling).
   * @param request - model, prompt, and provider options.
   * @param signal - optional cancellation.
   * @returns the created task id and its initial status.
   */
  async createTask(request: MojieMediaRequest, signal?: AbortSignal): Promise<{ id: string; model?: string; status: string }> {
    const payload = {
      model: request.model,
      prompt: request.prompt,
      ...request.resolution === undefined ? {} : { resolution: request.resolution },
      ...request.aspectRatio === undefined ? {} : { aspect_ratio: request.aspectRatio },
      ...request.inputImage === undefined ? {} : { input_image: request.inputImage },
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
   * @param image - image entry from a settled task.
   * @param signal - optional cancellation.
   * @returns bytes and the sniffed/declared media type.
   * @throws {LlmError} `UNSUPPORTED_CONTENT` for a non-image or oversized result.
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
    const maxBytes = this.options.downloadMaxBytes ?? 20 * 1024 * 1024
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new LlmError(`generated image is ${declared} bytes, over the ${maxBytes}-byte budget`, 'UNSUPPORTED_CONTENT')
    }
    const data = new Uint8Array(await response.arrayBuffer())
    if (data.byteLength > maxBytes) {
      throw new LlmError(`generated image is ${data.byteLength} bytes, over the ${maxBytes}-byte budget`, 'UNSUPPORTED_CONTENT')
    }
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
