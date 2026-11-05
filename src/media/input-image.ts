import { readFile } from 'node:fs/promises'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { extname, isAbsolute, resolve } from 'node:path'
import sharp, { type Metadata } from 'sharp'
import { isTrustedImageUrl } from './url-allowlist.js'

/**
 * Validation and preparation of edit references.
 *
 * This is the last gate before `input_image_urls` reaches the provider. Every
 * reference becomes either an untouched `data:` URL (within limits), a WebP
 * data URL (compressed once), or a probed public http(s) URL. Any failure throws
 * a bilingual error and the whole call stops, so a bad image never reaches the
 * model.
 *
 * @module @deepseek-ai/dsh-mojie-model-provider/media/input-image
 */

/** Decoded bytes above this trigger one WebP/quality pass. */
export const MAX_INPUT_BYTES = 5 * 1024 * 1024
/** Long edge above this triggers the same single pass. */
export const MAX_INPUT_SIDE = 4096
/** WebP quality for that pass. */
export const WEBP_QUALITY = 80
/** How many references are prepared at once; sharp already threads internally. */
export const INPUT_CONCURRENCY = 2
/** URL probe timeout. */
export const URL_PROBE_TIMEOUT_MS = 5_000
/** Maximum redirects followed by a probe. */
export const URL_PROBE_REDIRECTS = 2

const ALLOWED_FORMATS = new Map([
  ['png', 'image/png'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
])

/** One bilingual error for the model and the user behind it. */
function imageError(english: string, chinese: string): Error {
  return new Error(`${english} — ${chinese}`)
}

/**
 * Resolve every edit reference, preserving order.
 *
 * Runs at most `limit` preparations concurrently; the first failure rejects the
 * whole batch. The caller must not submit a partial list.
 * @param references - raw references from `input_images`.
 * @param sessionDirectory - the Session's current directory, for relative paths.
 * @param limit - concurrency cap.
 * @returns provider-ready URL or data URL strings.
 */
export async function resolveInputImages(
  references: readonly string[],
  sessionDirectory: string | undefined,
  limit: number = INPUT_CONCURRENCY,
): Promise<string[]> {
  const results = new Array<string>(references.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, references.length)) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= references.length) return
      results[index] = await resolveInputImage(references[index]!, sessionDirectory)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Turn one reference into something the provider can consume.
 *
 * `http(s)` URLs are signature-stripped and probed; local paths and `data:` URLs
 * are validated with sharp and compressed once when over the size/side limits.
 * @param value - raw reference.
 * @param sessionDirectory - Session directory for relative local paths.
 * @returns a URL or `data:` URL.
 */
export async function resolveInputImage(value: string, sessionDirectory: string | undefined): Promise<string> {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw imageError('image reference must be a non-empty string', '图片引用不能为空')
  }
  if (/^sha256:/iu.test(trimmed) || /^attachment:/iu.test(trimmed)) {
    throw imageError(
      'attachment ids are not accepted: they name the normalized display copy, not the original; pass the saved file path, the provider URL, or the read-only path in the image handle',
      '不接受附件 id，请传原图路径、图片 URL 或图片句柄里的只读路径',
    )
  }
  if (/^https?:\/\//iu.test(trimmed)) {
    return await resolveHttpUrl(trimmed)
  }
  if (trimmed.startsWith('data:')) {
    return await resolveDataUrl(trimmed)
  }
  return await resolveLocalFile(trimmed, sessionDirectory)
}

/** Validate one http(s) URL, stripping its signature before the probe. */
async function resolveHttpUrl(value: string): Promise<string> {
  if (isTrustedImageUrl(value)) return value
  let stripped: string
  try {
    stripped = stripUrlSignature(value)
  } catch {
    throw imageError(`invalid URL: ${value}`, '图片 URL 格式不正确')
  }
  // Content-type is not part of the gate: many image hosts serve
  // application/octet-stream. The file suffix and a reachable 200 are the
  // accepted heuristic.
  if (!isImageFileUrl(stripped)) {
    throw imageError(
      `URL does not end with an image file extension (.png/.jpg/.jpeg/.webp/.gif): ${stripped}`,
      '图片 URL 不是常见图片后缀，请下载到本地使用',
    )
  }
  await probeImageUrl(stripped)
  return stripped
}

/** Whether one URL's path ends in one of the accepted image extensions. */
export function isImageFileUrl(value: string): boolean {
  try {
    const pathname = new URL(value).pathname.toLowerCase()
    return ['.png', '.jpg', '.jpeg', '.webp', '.gif'].some((suffix) => pathname.endsWith(suffix))
  } catch {
    return false
  }
}

/**
 * Remove the query string (signature, tracking, anti-hotlink parameters) and
 * fragment from one URL. The stripped URL is what gets probed and returned: if
 * the original only worked because of a signature, the provider could not fetch
 * it either, so the user must download the file instead.
 * @param value - original http(s) URL.
 * @returns the same URL without `?…` or `#…`.
 */
export function stripUrlSignature(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('unsupported URL scheme')
  }
  url.search = ''
  url.hash = ''
  return url.toString()
}

/** Reject loopback/private/reserved targets before any fetch (SSRF). */
async function assertPublicTarget(url: URL, lookupImpl: typeof lookup = lookup): Promise<void> {
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw imageError('URL points to a local or private address and is not allowed', '图片 URL 指向本地或内网地址，无法使用')
  }
  if (isIP(host) !== 0) {
    if (!isPublicAddress(host)) {
      throw imageError('URL points to a local or private address and is not allowed', '图片 URL 指向本地或内网地址，无法使用')
    }
    return
  }
  let addresses: Array<{ address: string }>
  try {
    addresses = await lookupImpl(host, { all: true }) as Array<{ address: string }>
  } catch {
    throw imageError(`URL host could not be resolved: ${host}`, '图片地址无法解析，请下载到本地使用')
  }
  if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw imageError('URL points to a local or private address and is not allowed', '图片 URL 指向本地或内网地址，无法使用')
  }
}

/** IPv4/IPv6 private, loopback, link-local, and reserved ranges. */
function isPublicAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) {
    const parts = address.split('.').map(Number)
    const [a = 0, b = 0] = parts
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    if (a === 198 && (b === 18 || b === 19)) return false
    return true
  }
  if (version === 6) {
    const normalized = address.toLowerCase()
    if (normalized === '::1' || normalized === '::') return false
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false
    if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return false
    return true
  }
  return false
}

/**
 * Probe one URL with HEAD, falling back to a small ranged GET.
 * @param value - stripped http(s) URL.
 * @param options - injection seams for tests.
 */
export async function probeImageUrl(
  value: string,
  options: {
    fetchImpl?: typeof fetch
    lookupImpl?: typeof lookup
    timeoutMs?: number
  } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? URL_PROBE_TIMEOUT_MS
  let current: URL
  try {
    current = new URL(value)
  } catch {
    throw imageError(`invalid URL: ${value}`, '图片 URL 格式不正确')
  }
  for (let hop = 0; hop <= URL_PROBE_REDIRECTS; hop += 1) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw imageError('URL scheme is not allowed', '图片 URL 协议不支持')
    }
    await assertPublicTarget(current, options.lookupImpl)
    const signal = AbortSignal.timeout(timeoutMs)
    let response: Response
    try {
      response = await fetchImpl(current, {
        method: 'HEAD',
        redirect: 'manual',
        signal,
        headers: { accept: 'image/*' },
      })
    } catch {
      throw imageError(`URL is not reachable: ${current.toString()}`, '网络图片地址不可达，请下载到本地使用')
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (location === null) {
        throw imageError('URL redirects without a target', '图片 URL 重定向异常，请下载到本地使用')
      }
      current = new URL(location, current)
      continue
    }
    if (response.status === 405 || response.status === 403 || response.status === 400) {
      // Some CDNs refuse HEAD; try a tiny ranged GET instead.
      try {
        response = await fetchImpl(current, {
          method: 'GET',
          redirect: 'manual',
          signal,
          headers: { accept: 'image/*', range: 'bytes=0-1023' },
        })
      } catch {
        throw imageError(`URL is not reachable: ${current.toString()}`, '网络图片地址不可达，请下载到本地使用')
      }
      await response.body?.cancel()
    }
    if (response.status !== 200 && response.status !== 206) {
      throw imageError(
        `URL is not reachable (status ${response.status}); it may require a signature or block downloads — use a local file instead`,
        '网络图片地址不可达（可能需要签名或禁止下载），请下载到本地使用',
      )
    }
    // Content-type is intentionally ignored: some image hosts answer
    // application/octet-stream. Reachable + image suffix is the accepted check.
    return
  }
  throw imageError('URL redirected too many times', '图片 URL 重定向次数过多，请下载到本地使用')
}

/** Validate and, if needed, compress one local image file. */
async function resolveLocalFile(value: string, sessionDirectory: string | undefined): Promise<string> {
  const candidates = isAbsolute(value)
    ? [value]
    : [...new Set([
      ...sessionDirectory === undefined ? [] : [resolve(sessionDirectory, value)],
      resolve(process.cwd(), value),
    ])]
  const failures: string[] = []
  for (const candidate of candidates) {
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await readFile(candidate))
    } catch (cause) {
      failures.push(`${candidate} (${cause instanceof Error ? cause.message : String(cause)})`)
      continue
    }
    return await prepareImageBytes(bytes)
  }
  throw imageError(
    `cannot read image reference "${value}": ${failures.join('; ')}`,
    '图片文件读取失败，请确认路径是否正确',
  )
}

/** Decode one `data:` URL and validate/compress its image bytes. */
async function resolveDataUrl(value: string): Promise<string> {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/u.exec(value)
  if (match === null) {
    throw imageError('malformed data URL', '图片 base64 数据格式不正确')
  }
  let bytes: Uint8Array
  try {
    bytes = match[2] === undefined
      ? new Uint8Array(Buffer.from(decodeURIComponent(match[3] ?? ''), 'utf8'))
      : new Uint8Array(Buffer.from((match[3] ?? '').replace(/\s+/gu, ''), 'base64'))
  } catch {
    throw imageError('data URL payload is not valid base64', '图片 base64 数据无法解码')
  }
  if (bytes.byteLength === 0) {
    throw imageError('data URL carries no image bytes', '图片 base64 数据为空')
  }
  return await prepareImageBytes(bytes)
}

/**
 * Validate one image with sharp and apply the single compression pass when the
 * decoded bytes exceed 5 MiB or the long edge exceeds 4096 px.
 * @param bytes - decoded source bytes.
 * @returns a `data:` URL of the original bytes (within limits) or WebP (processed).
 */
export async function prepareImageBytes(bytes: Uint8Array): Promise<string> {
  let metadata: Metadata
  try {
    metadata = await sharp(bytes, { animated: false }).metadata()
  } catch (error) {
    throw imageError(
      `cannot decode the image: ${error instanceof Error ? error.message : String(error)}; the file may be truncated or corrupt`,
      '图片无法解码，可能已损坏或不是有效图片',
    )
  }
  const format = metadata.format ?? ''
  const mediaType = ALLOWED_FORMATS.get(format)
  if (mediaType === undefined) {
    throw imageError(
      `unsupported image format "${format || 'unknown'}"; only PNG/JPEG/WebP/GIF are accepted`,
      '不支持的图片格式，请使用 PNG/JPEG/WebP/GIF',
    )
  }
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  const tooLarge = bytes.byteLength > MAX_INPUT_BYTES
  const tooWide = Math.max(width, height) > MAX_INPUT_SIDE
  if (!tooLarge && !tooWide) {
    return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`
  }
  try {
    const output = await sharp(bytes, { animated: false })
      .rotate()
      .toColourspace('srgb')
      .resize({ width: MAX_INPUT_SIDE, height: MAX_INPUT_SIDE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer()
    return `data:image/webp;base64,${output.toString('base64')}`
  } catch (error) {
    throw imageError(
      `could not prepare the image for upload (${error instanceof Error ? error.message : String(error)})`,
      '图片压缩失败，请换一张图片或先自行压缩',
    )
  }
}

/** File extension to a media type; used only for diagnostics. */
export function mediaTypeForExtension(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    default: return undefined
  }
}
