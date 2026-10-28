import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { AttachmentId, type AttachmentStore, type ImageAttachmentRef, type ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ResolvedConfig } from '../config.js'
import { sniffImageMediaType, type MojieMediaClient, type MojieMediaTask } from '../media/client.js'

/**
 * Native image tools registered on `ctx.tools`: text-to-image, image edit, the
 * image-model listing, and task lookup.
 *
 * They are ordinary first-party tools 鈥?always in the schema set, no skill load
 * required 鈥?and every generated picture is saved into the durable attachment
 * store, so the result renders in the conversation exactly like `read_image`.
 *
 * @module @mojieai/dsh-mojie-model-provider/tools/image
 */

/** Host wiring the tools need. */
export interface MojieImageToolOptions {
  /** Read the live plugin configuration for one call. */
  readonly config: () => ResolvedConfig
  /** Build a media client bound to the live configuration and credential. */
  readonly media: () => Promise<MojieMediaClient>
  /** Durable attachment store; image results fall back to links when absent. */
  readonly attachments: () => AttachmentStore | undefined
}

const SUPPORTED_IMAGE_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** One stored image, as carried through the canonical tool value. */
const SAVED_IMAGE_VALUE = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    attachment_id: { type: 'string' as const, required: true as const },
    media_type: { type: 'string' as const, required: true as const, enum: SUPPORTED_IMAGE_TYPES },
    bytes: { type: 'integer' as const, required: true as const },
    width: { type: 'integer' as const, required: true as const },
    height: { type: 'integer' as const, required: true as const },
  },
}

/** One generated image plus its optional stored copy. */
const IMAGE_VALUE = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    url: { type: 'string' as const, required: true as const },
    mime_type: { type: 'string' as const },
    saved: SAVED_IMAGE_VALUE,
  },
}

/** Canonical value of one generation/edit/list call. */
const TASK_VALUE = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    task_id: { type: 'string' as const, required: true as const },
    model: { type: 'string' as const },
    status: { type: 'string' as const, required: true as const },
    images: { type: 'array' as const, items: IMAGE_VALUE },
    note: { type: 'string' as const },
  },
}

const MODELS_VALUE = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    models: { type: 'array' as const, required: true as const, items: { type: 'string' as const } },
  },
}

/** Mirrors the canonical value shape above. */
interface TaskValue {
  task_id: string
  model?: string
  status: string
  images?: Array<{
    url: string
    mime_type?: string
    saved?: { attachment_id: string; media_type: ImageMediaType; bytes: number; width: number; height: number }
  }>
  note?: string
}

/**
 * Register the native Mojie image tools on the calling context's `ctx.tools`.
 *
 * Mount this inside `ctx.inject(['tools'], 鈥?` so the tools exist only where the
 * tool registry does; each execution re-reads the configuration and resolve the
 * credential, so settings edits apply without a restart.
 * @param ctx - context carrying the `tools` service.
 * @param options - configuration, media-client factory, and attachment store accessor.
 */
export function registerImageTools(ctx: Context, options: MojieImageToolOptions): void {
  ctx.tools.register(defineTool({
    name: 'mojie_list_image_models',
    description: 'List the Mojie image-generation models this key can call. Call this before choosing a model for mojie_generate_image or mojie_edit_image when the user names a style or the default model is unsupported.',
    parameters: {},
    output: {
      schema: MODELS_VALUE,
      render: (_args, value) => [{
        type: 'text',
        text: value.models.length === 0
          ? 'No image models are available for this API key.'
          : `Mojie image models (${value.models.length}):\n${value.models.map((model) => `- ${model}`).join('\n')}`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const client = await options.media()
      return { models: await client.listModels(exec.signal) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mojie_generate_image',
    description: 'Generate an image from a text prompt with Mojie and return it as a picture in the conversation. Use this for any image creation, AI art, illustration, poster, icon, or style request. This is the native path: do not call the image-generation skill or shell out to scripts for image creation. The call waits for the task; if it is still running when the wait ends you get a task_id to poll with mojie_image_task.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'What to draw: subject, composition, style, lighting, colors. Self-contained and specific. Use the language of the user\'s request.',
      },
      model: {
        type: 'string',
        description: 'Image model id from mojie_list_image_models. Omit to use the configured default (seedream-5-image unless the deployment changed it).',
      },
      resolution: {
        type: 'string',
        description: 'Provider resolution, e.g. `1K`, `2K`. Omit for the configured default.',
      },
      aspect_ratio: {
        type: 'string',
        description: 'Provider aspect ratio, e.g. `1:1`, `16:9`, `9:16`, `4:3`. Omit for the configured default.',
      },
    },
    output: {
      schema: TASK_VALUE,
      render: (_args, value) => renderTask(value),
    },
    async execute(args, exec) {
      const config = options.config()
      const client = await options.media()
      const task = await client.generate({
        model: args.model ?? config.imageDefaultModel,
        prompt: args.prompt,
        resolution: args.resolution ?? config.imageDefaultResolution,
        aspectRatio: args.aspect_ratio ?? config.imageDefaultAspectRatio,
      }, exec.signal)
      return await taskValue(task, options, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mojie_edit_image',
    description: 'Edit or restyle an existing image with Mojie and return the result as a picture in the conversation. Pass the reference image as an HTTPS URL, a data: URL, or a local file path. Use this for background changes, color grading, object removal or addition, restyling, or any image-to-image request. Native path for image editing: prefer it over shell scripts and image libraries.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'How to change the reference image. Name exactly what changes and what must stay identical.',
      },
      input_image: {
        type: 'string',
        required: true,
        description: 'Reference image: HTTPS URL, data: URL, or a local file path readable by the host process.',
      },
      model: {
        type: 'string',
        description: 'Image model id from mojie_list_image_models. Omit for the configured default.',
      },
      resolution: {
        type: 'string',
        description: 'Provider resolution, e.g. `1K`, `2K`. Omit for the configured default.',
      },
      aspect_ratio: {
        type: 'string',
        description: 'Provider aspect ratio, e.g. `1:1`, `16:9`. Omit for the configured default.',
      },
    },
    output: {
      schema: TASK_VALUE,
      render: (_args, value) => renderTask(value),
    },
    async execute(args, exec) {
      const config = options.config()
      const client = await options.media()
      const inputImage = await resolveInputImage(args.input_image, config.imageDownloadMaxBytes)
      const task = await client.generate({
        model: args.model ?? config.imageDefaultModel,
        prompt: args.prompt,
        resolution: args.resolution ?? config.imageDefaultResolution,
        aspectRatio: args.aspect_ratio ?? config.imageDefaultAspectRatio,
        inputImage,
      }, exec.signal)
      return await taskValue(task, options, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mojie_image_task',
    description: 'Read the current state of a Mojie image task by its task_id, and attach the finished picture once it succeeds. Use it when mojie_generate_image or mojie_edit_image returned status processing instead of a completed image.',
    parameters: {
      task_id: {
        type: 'string',
        required: true,
        description: 'Task id returned by mojie_generate_image or mojie_edit_image.',
      },
    },
    output: {
      schema: TASK_VALUE,
      render: (_args, value) => renderTask(value),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const client = await options.media()
      const task = await client.getTask(args.task_id, exec.signal)
      if (task.status === 'failed') {
        return {
          task_id: task.id,
          status: task.status,
          ...task.model === undefined ? {} : { model: task.model },
          note: task.error ?? 'the provider reported a failure',
        }
      }
      return await taskValue(task, options, exec.signal)
    },
  }))
}

/** Project one settled task into the canonical value, storing images when possible. */
async function taskValue(task: MojieMediaTask, options: MojieImageToolOptions, signal?: AbortSignal): Promise<TaskValue> {
  const attachments = options.attachments()
  const value: TaskValue = {
    task_id: task.id,
    status: task.status,
    ...task.model === undefined ? {} : { model: task.model },
  }
  if (task.images.length === 0) {
    return task.status === 'succeeded'
      ? { ...value, note: 'the provider reported success without an image' }
      : { ...value, note: 'the task is still running; call mojie_image_task again later' }
  }
  const client = await options.media()
  const images: NonNullable<TaskValue['images']> = []
  for (const image of task.images) {
    const entry: NonNullable<TaskValue['images']>[number] = {
      url: image.url,
      ...image.mimeType === undefined ? {} : { mime_type: image.mimeType },
    }
    if (attachments !== undefined) {
      try {
        const { data, mediaType } = await client.download(image, signal)
        const ref = await attachments.saveImage({ data, mediaType, name: `mojie-${task.id}` })
        entry.saved = {
          attachment_id: ref.attachmentId,
          media_type: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
        }
      } catch (error) {
        // A download or storage failure must not hide the URL the provider did produce.
        value.note = `the image was generated but could not be stored locally (${errorMessage(error)}); the URL is usable`
      }
    }
    images.push(entry)
    if (images.length >= 4) break
  }
  return { ...value, images }
}

/** Render one task value as a short envelope plus the pictures themselves. */
function renderTask(value: TaskValue): ContentBlock[] {
  const lines = [`Mojie image task ${value.task_id}`, `status: ${value.status}`]
  if (value.model !== undefined) lines.push(`model: ${value.model}`)
  for (const [index, image] of (value.images ?? []).entries()) {
    lines.push(image.saved === undefined
      ? `${index + 1}. ![image](${image.url})`
      : `${index + 1}. ${image.saved.media_type}, ${image.saved.width}x${image.saved.height}px, ${image.saved.bytes} bytes`)
  }
  if (value.note !== undefined) lines.push(value.note)
  const blocks: ContentBlock[] = [{ type: 'text', text: lines.join('\n') }]
  for (const image of value.images ?? []) {
    if (image.saved === undefined) continue
    blocks.push({ type: 'image', attachment: toImageRef(image.saved) })
  }
  return blocks
}

/** Rebuild the durable image reference a stored value describes. */
function toImageRef(saved: NonNullable<NonNullable<TaskValue['images']>[number]['saved']>): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(saved.attachment_id),
    mediaType: saved.media_type,
    bytes: saved.bytes,
    width: saved.width,
    height: saved.height,
  }
}

/**
 * Normalize the reference image argument: pass URLs through and inline a local
 * file as a data URL so the gateway can read it.
 */
async function resolveInputImage(value: string, maxBytes: number): Promise<string> {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error('input_image must be a non-empty string')
  if (/^https?:\/\//iu.test(trimmed) || trimmed.startsWith('data:')) return trimmed
  const path = isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed)
  let data: Uint8Array
  try {
    data = new Uint8Array(await readFile(path))
  } catch (cause) {
    throw new Error(`cannot read input_image "${path}": ${errorMessage(cause)}`, { cause })
  }
  if (data.byteLength > maxBytes) {
    throw new Error(`input_image is ${data.byteLength} bytes, over the ${maxBytes}-byte budget`)
  }
  const mediaType = sniffImageMediaType(data) ?? mediaTypeForExtension(path)
  if (mediaType === undefined) {
    throw new Error(`cannot use "${path}" as input_image: it is not a PNG/JPEG/WebP/GIF image`)
  }
  return `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`
}

/** Declared media type from a file extension, when the bytes were not enough. */
function mediaTypeForExtension(path: string): ImageMediaType | undefined {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    default: return undefined
  }
}

/** Best-effort one-line error text for envelopes. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
