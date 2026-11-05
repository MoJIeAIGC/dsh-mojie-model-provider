import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { AttachmentId, type AttachmentStore, type ImageAttachmentRef, type ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { imageDimensions } from './dimensions.js'
import { writeOriginalFile } from './session-file.js'
import { rememberReturnedImageUrl } from './url-allowlist.js'
import type { MojieMediaClient, MojieMediaTask } from './client.js'

/**
 * Persistence and model-facing projection shared by the native tools and the
 * `/image` command.
 *
 * One settled provider task is projected once: every image the provider
 * returned is downloaded, the provider's exact bytes are written into the
 * Session directory, a durable attachment is created as the display copy, and
 * the provider URL is always kept on the value so the conversation can hand it
 * back to the user and the model. Nothing here caps the image count.
 *
 * @module @deepseek-ai/dsh-mojie-model-provider/media/task-store
 */

/** One generated image as the Session stores and reports it. */
export interface StoredImage {
  /** Provider URL. Always present, including when every local write failed. */
  url: string
  mime_type?: string
  media_type?: ImageMediaType
  bytes?: number
  width?: number
  height?: number
  /** The provider's exact bytes on disk, when the Session directory accepted them. */
  path?: string
  /** Display copy in the durable attachment store, when one covers it. */
  saved?: {
    attachment_id: string
    media_type: ImageMediaType
    bytes: number
    width: number
    height: number
  }
}

/** Canonical, losslessly JSON-serializable result of one media task. */
export interface StoredTask {
  task_id: string
  model?: string
  status: string
  images?: StoredImage[]
  note?: string
}

/** Host services both callers provide. */
export interface TaskStoreOptions {
  /** Build a media client bound to the live configuration and credential. */
  readonly media: () => Promise<MojieMediaClient>
  /** Durable attachment store; its entry is the display copy. */
  readonly attachments: () => AttachmentStore | undefined
  /** Resolve the calling Session's current working directory. */
  readonly sessionDirectory: (agent: unknown, signal?: AbortSignal) => Promise<string>
}

/**
 * Persist one settled task.
 *
 * Every image is processed: download (no byte cap), original file write (no
 * re-encoding, idempotent per task id), display copy (best effort), and the
 * provider URL is always retained. Failures are collected into `note`; one bad
 * image never hides the others.
 * @param task - the settled provider task.
 * @param options - host services.
 * @param agent - the calling Agent (Session identity for the working directory).
 * @param signal - cancellation.
 * @returns the stored task value.
 */
export async function storeTask(
  task: MojieMediaTask,
  options: TaskStoreOptions,
  agent: unknown,
  signal?: AbortSignal,
): Promise<StoredTask> {
  const notes: string[] = []
  const base = {
    task_id: task.id,
    status: task.status,
    ...task.model === undefined ? {} : { model: task.model },
  }
  if (task.images.length === 0) {
    return {
      ...base,
      note: task.status === 'succeeded'
        ? 'the provider reported success without an image'
        : 'the task is still running; call mojie_image_task again later',
    }
  }
  const client = await options.media()
  let directory: string | undefined
  try {
    directory = await options.sessionDirectory(agent, signal)
  } catch (error) {
    notes.push(`could not resolve the Session directory (${errorMessage(error)})`)
  }
  const attachments = options.attachments()
  const images: StoredImage[] = []
  for (const [index, image] of task.images.entries()) {
    const position = index + 1
    // URLs the provider just returned are trusted edit references for this process.
    rememberReturnedImageUrl(image.url)
    let data: Uint8Array
    let mediaType: ImageMediaType
    try {
      ({ data, mediaType } = await client.download(image, signal))
    } catch (error) {
      notes.push(`image ${position} could not be downloaded (${errorMessage(error)}); its URL is still usable`)
      images.push({
        url: image.url,
        ...image.mimeType === undefined ? {} : { mime_type: image.mimeType },
      })
      continue
    }
    const dimensions = imageDimensions(data)
    const entry: StoredImage = {
      url: image.url,
      ...image.mimeType === undefined ? {} : { mime_type: image.mimeType },
      media_type: mediaType,
      bytes: data.byteLength,
      ...dimensions === undefined ? {} : { width: dimensions.width, height: dimensions.height },
    }
    if (directory !== undefined) {
      try {
        entry.path = await writeOriginalFile(directory, task.id, position, data, mediaType)
      } catch (error) {
        notes.push(`could not write image ${position} into the Session directory (${errorMessage(error)})`)
      }
    }
    if (attachments !== undefined) {
      try {
        const ref = await attachments.saveImage({ data, mediaType, name: `mojie-${task.id}` })
        entry.saved = {
          attachment_id: ref.attachmentId,
          media_type: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
        }
      } catch (error) {
        notes.push(`image ${position} has no display copy (${errorMessage(error)})`)
      }
    }
    images.push(entry)
  }
  return notes.length === 0
    ? { ...base, images }
    : { ...base, images, note: notes.join('; ') }
}

/**
 * Model-facing text for one stored task.
 *
 * Every image reports its provider URL first: the URL is the reference that
 * always exists, regardless of the Session directory or the attachment store.
 * @param value - one stored task value.
 * @returns the envelope text.
 */
export function taskText(value: StoredTask): string {
  const lines = [`Mojie image task ${value.task_id}`, `status: ${value.status}`]
  if (value.model !== undefined) lines.push(`model: ${value.model}`)
  for (const [index, image] of (value.images ?? []).entries()) {
    lines.push(`${index + 1}. url: ${image.url}`)
    const media = image.media_type ?? image.mime_type ?? 'image'
    if (image.path !== undefined) {
      const size = image.width === undefined || image.height === undefined
        ? `${image.bytes ?? '?'} bytes`
        : `${image.width}x${image.height}px, ${image.bytes ?? '?'} bytes`
      lines.push(`   file: ${image.path} (${media}, ${size})`)
    } else if (image.saved !== undefined) {
      lines.push(`   stored display copy: ${image.saved.media_type}, ${image.saved.width}x${image.saved.height}px, ${image.saved.bytes} bytes`)
    }
  }
  if (value.note !== undefined) lines.push(value.note)
  return lines.join('\n')
}

/** Render one stored task as the envelope plus every display copy. */
export function renderTask(value: StoredTask): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: 'text', text: taskText(value) }]
  for (const image of value.images ?? []) {
    if (image.saved === undefined) continue
    blocks.push({ type: 'image', attachment: toImageRef(image.saved) })
  }
  return blocks
}

/** Rebuild one durable image reference from the stored value. */
export function toImageRef(saved: NonNullable<StoredImage['saved']>): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(saved.attachment_id),
    mediaType: saved.media_type,
    bytes: saved.bytes,
    width: saved.width,
    height: saved.height,
  }
}

/** Best-effort one-line error text for envelopes. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
