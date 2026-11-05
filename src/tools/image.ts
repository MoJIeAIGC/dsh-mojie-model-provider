import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AttachmentStore, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ResolvedConfig } from '../config.js'
import { chooseImageModel } from '../media/model-memory.js'
import { resolveInputImages } from '../media/input-image.js'
import { renderTask, storeTask, type StoredTask } from '../media/task-store.js'
import type { MojieMediaClient, MojieMediaTask } from '../media/client.js'

/**
 * Native image tools registered on `ctx.tools`: text-to-image, image edit, the
 * image-model listing, and task lookup.
 *
 * They are ordinary first-party tools — always in the schema set, no skill load
 * required. Persistence is shared with the `/image` command through
 * `media/task-store`: every image the provider returns is downloaded, the
 * provider's exact bytes are written into the calling Session's working
 * directory, a durable attachment is created as the display copy, and the
 * provider URL is always reported. The visible conversation row lives in
 * `src/client/toolview.js`.
 *
 * @module @deepseek-ai/dsh-mojie-model-provider/tools/image
 */

/** Host wiring the tools need. */
export interface MojieImageToolOptions {
  /** Read the live plugin configuration for one call. */
  readonly config: () => ResolvedConfig
  /** Build a media client bound to the live configuration and credential. */
  readonly media: () => Promise<MojieMediaClient>
  /** Durable attachment store; its entry is the display copy. */
  readonly attachments: () => AttachmentStore | undefined
  /** Resolve the calling Session's current working directory. */
  readonly sessionDirectory: (agent: unknown, signal?: AbortSignal) => Promise<string>
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

/** One generated image: provider URL, saved original, and display copy. */
const IMAGE_VALUE = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    url: { type: 'string' as const, required: true as const },
    mime_type: { type: 'string' as const },
    media_type: { type: 'string' as const, enum: SUPPORTED_IMAGE_TYPES },
    bytes: { type: 'integer' as const },
    width: { type: 'integer' as const },
    height: { type: 'integer' as const },
    path: { type: 'string' as const },
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

/** The persisted task value, shared with `/image`. */
type TaskValue = StoredTask

/**
 * Register the native Mojie image tools on the calling context's `ctx.tools`.
 *
 * Mount this inside `ctx.inject(['tools'], …)` so the tools exist only where the
 * tool registry does; each execution re-reads the configuration and resolves
 * the credential, so settings edits apply without a restart.
 * @param ctx - context carrying the `tools` service.
 * @param options - configuration, media-client factory, attachment store, and Session directory accessor.
 */
export function registerImageTools(ctx: Context, options: MojieImageToolOptions): void {
  ctx.tools.register(defineTool({
    name: 'mojie_list_image_models',
    description: 'List the Mojie image-generation models this key can call. Call this only when the user asks for a specific image model or the default fails; a loose name (for example "image 2.5") must be resolved here to one exact id, and when several models match you must ask the user which one. When the user does not name a model, omit the `model` parameter on the image tools so the deployment default applies.',
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
    description: 'Generate an image from a text prompt with Mojie and return it as a picture in the conversation. Use this for any image creation, AI art, illustration, poster, icon, or style request. This is the native path: do not call the image-generation skill or shell out to scripts for image creation. Keep using the image model already chosen in this conversation unless the user explicitly asks for a different one. Every result reports the provider URL and the saved file path; tell the user the URL when the picture is ready, and read the saved file if you need the picture itself. The call waits for the task; if it is still running when the wait ends you get a task_id to poll with mojie_image_task.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'What to draw: subject, composition, style, lighting, colors. Self-contained and specific. Use the language of the user\'s request.',
      },
      model: {
        type: 'string',
        description: 'Only pass an image model id when the user explicitly names one; resolve a loose name through mojie_list_image_models to an exact id and ask the user when several models match. Otherwise omit this parameter: the deployment default is used and must not be guessed or copied from an example. Never switch models on your own — reuse the model already used earlier in this conversation unless the user explicitly changes it.',
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
      render: (_args, value) => renderTask(value as never),
      presentationMeta: (_args, value) => taskMeta(value as never),
    },
    async execute(args, exec) {
      const config = options.config()
      const client = await options.media()
      const task = await client.generate({
        model: chooseImageModel(exec.agent, args.model, config.imageDefaultModel),
        prompt: args.prompt,
        resolution: args.resolution ?? config.imageDefaultResolution,
        aspectRatio: args.aspect_ratio ?? config.imageDefaultAspectRatio,
      }, exec.signal)
      return await storeTask(task, options, exec.agent, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mojie_edit_image',
    description: 'Edit, restyle, or fuse existing images with Mojie and return the result as pictures in the conversation. Pass every reference image in `input_images`, in the order the user gave them — a single reference is a one-element array: HTTPS URLs, data: URLs, or local file paths. Never use the `sha256:` attachment id, which names the normalized display copy rather than the picture the user received. When the user refers to images generated earlier in this Session, use the `file:` path each result reported (the untouched original), or its provider URL. When the user refers to an image they just uploaded in this message, pass the read-only file path shown in that image\'s handle text; that normalized copy is the only one the host kept for an upload. Keep using the image model already chosen in this conversation unless the user explicitly asks for a different one. Every result is saved into the current working directory and reports its provider URL and file path.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'How to change the reference images. Name exactly what changes and what must stay identical.',
      },
      input_images: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Every reference image, in the user\'s order; one reference is a one-element array. Each item is an HTTPS URL, a data: URL, a local file path, the `file:` path a previous result reported, or the read-only path shown in a just-uploaded image\'s handle. A read-only handle path is read directly — do not copy it to a writable path first. The array itself must not be empty.',
      },
      model: {
        type: 'string',
        description: 'Only pass an image model id when the user explicitly names one; resolve a loose name through mojie_list_image_models to an exact id and ask the user when several models match. Otherwise omit this parameter: the deployment default is used and must not be guessed or copied from an example. Never switch models on your own — reuse the model already used earlier in this conversation unless the user explicitly changes it.',
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
      render: (_args, value) => renderTask(value as never),
      presentationMeta: (_args, value) => taskMeta(value as never),
    },
    async execute(args, exec) {
      const config = options.config()
      const client = await options.media()
      // References resolve relative to the Session directory, because that is
      // where generated originals live.
      const directory = await optionalSessionDirectory(options, exec)
      if (args.input_images.length === 0) {
        throw new Error('mojie_edit_image requires at least one reference image in input_images')
      }
      const inputImages = await resolveInputImages(args.input_images, directory)
      const task = await client.generate({
        model: chooseImageModel(exec.agent, args.model, config.imageDefaultModel),
        prompt: args.prompt,
        resolution: args.resolution ?? config.imageDefaultResolution,
        aspectRatio: args.aspect_ratio ?? config.imageDefaultAspectRatio,
        inputImages,
      }, exec.signal)
      return await storeTask(task, options, exec.agent, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mojie_image_task',
    description: 'Read the current state of a Mojie image task by its task_id, and attach every finished picture once it succeeds. Use it when mojie_generate_image or mojie_edit_image returned status processing instead of a completed image.',
    parameters: {
      task_id: {
        type: 'string',
        required: true,
        description: 'Task id returned by mojie_generate_image or mojie_edit_image.',
      },
    },
    output: {
      schema: TASK_VALUE,
      render: (_args, value) => renderTask(value as never),
      presentationMeta: (_args, value) => taskMeta(value as never),
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
      return await storeTask(task, options, exec.agent, exec.signal)
    },
  }))
}

/** Presentation metadata the conversation row reads instead of parsing text. */
function taskMeta(value: TaskValue) {
  const files = (value.images ?? []).flatMap((image) => image.path === undefined ? [] : [{
    path: image.path,
    media_type: image.media_type ?? 'image/png',
    bytes: image.bytes ?? 0,
    ...image.width === undefined ? {} : { width: image.width },
    ...image.height === undefined ? {} : { height: image.height },
  }])
  return {
    task_id: value.task_id,
    status: value.status,
    ...value.model === undefined ? {} : { model: value.model },
    ...value.note === undefined ? {} : { note: value.note },
    files,
    urls: (value.images ?? []).map((image) => image.url),
  }
}

/** Resolve the Session directory without failing a read-only operation. */
async function optionalSessionDirectory(
  options: MojieImageToolOptions,
  exec: { signal?: AbortSignal; agent?: unknown },
): Promise<string | undefined> {
  try {
    return await options.sessionDirectory(exec.agent, exec.signal)
  } catch {
    return undefined
  }
}

