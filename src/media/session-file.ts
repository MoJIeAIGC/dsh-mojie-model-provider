import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { extensionFor } from './dimensions.js'

/**
 * Naming and writing of the provider's original files.
 *
 * The artifact is the provider's byte stream, saved once per generation; the
 * file name encodes the generation id, which makes a repeated poll idempotent
 * without content hashing or deduplication.
 *
 * @module @deepseek-ai/dsh-mojie-model-provider/media/session-file
 */

/** A task id is opaque; keep it file-name safe and bounded. */
export function sanitizeTaskId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64) || 'image'
}

/**
 * Deterministic file name for one generation and one image position.
 * @param taskId - the provider task id (the generation identity).
 * @param index - 1-based position within the task.
 * @param mediaType - the sniffed media type.
 * @returns a file name such as `mojie-task-7-1.png`.
 */
export function originalFileName(taskId: string, index: number, mediaType: string): string {
  return `mojie-${sanitizeTaskId(taskId)}-${index}.${extensionFor(mediaType)}`
}

/**
 * Write the provider's exact bytes into a directory, once.
 *
 * `wx` keeps a second poll of the same task from overwriting the first file; an
 * existing file is returned as-is because the name encodes the generation id.
 * Nothing here re-encodes, strips metadata, or hashes the content.
 * @param directory - the Session working directory.
 * @param taskId - the provider task id.
 * @param index - 1-based position within the task.
 * @param data - the exact bytes the provider served.
 * @param mediaType - the sniffed media type.
 * @returns the absolute path of the saved original.
 */
export async function writeOriginalFile(
  directory: string,
  taskId: string,
  index: number,
  data: Uint8Array,
  mediaType: string,
): Promise<string> {
  const path = join(directory, originalFileName(taskId, index, mediaType))
  try {
    await writeFile(path, data, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return path
}
