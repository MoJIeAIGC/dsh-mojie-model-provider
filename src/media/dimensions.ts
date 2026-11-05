/**
 * Minimal header readers for the generated image formats.
 *
 * The original bytes are written to the Session directory untouched, so the
 * dimensions reported to the model and the conversation row must come from the
 * bytes themselves — decoding or re-encoding them would violate the "save the
 * provider's original" contract.
 *
 * @module @deepseek-ai/dsh-mojie-model-provider/media/dimensions
 */

/** Pixel size of one image. */
export interface ImageDimensions {
  readonly width: number
  readonly height: number
}

function be16(data: Uint8Array, offset: number): number {
  return (data[offset]! << 8) | data[offset + 1]!
}

function be32(data: Uint8Array, offset: number): number {
  return ((data[offset]! << 24) | (data[offset + 1]! << 16) | (data[offset + 2]! << 8) | data[offset + 3]!) >>> 0
}

function le16(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8)
}

function startsWith(data: Uint8Array, offset: number, text: string): boolean {
  if (data.byteLength < offset + text.length) return false
  for (let index = 0; index < text.length; index += 1) {
    if (data[offset + index] !== text.charCodeAt(index)) return false
  }
  return true
}

/** JPEG start-of-frame markers that carry the frame size. */
function isJpegFrameMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

function jpegDimensions(data: Uint8Array): ImageDimensions | undefined {
  let offset = 2
  while (offset + 4 <= data.byteLength) {
    if (data[offset] !== 0xff) return undefined
    const marker = data[offset + 1]!
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = be16(data, offset + 2)
    if (length < 2) return undefined
    if (isJpegFrameMarker(marker)) {
      if (offset + 9 > data.byteLength) return undefined
      const height = be16(data, offset + 5)
      const width = be16(data, offset + 7)
      return width > 0 && height > 0 ? { width, height } : undefined
    }
    offset += 2 + length
  }
  return undefined
}

function webpDimensions(data: Uint8Array): ImageDimensions | undefined {
  if (data.byteLength < 30) return undefined
  if (startsWith(data, 12, 'VP8 ')) {
    const width = le16(data, 26) & 0x3fff
    const height = le16(data, 28) & 0x3fff
    return width > 0 && height > 0 ? { width, height } : undefined
  }
  if (startsWith(data, 12, 'VP8L')) {
    if (data[20] !== 0x2f) return undefined
    const bits = data[21]! | (data[22]! << 8) | (data[23]! << 16) | (data[24]! << 24)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >>> 14) & 0x3fff) + 1
    return { width, height }
  }
  if (startsWith(data, 12, 'VP8X')) {
    const width = 1 + (data[24]! | (data[25]! << 8) | (data[26]! << 16))
    const height = 1 + (data[27]! | (data[28]! << 8) | (data[29]! << 16))
    return { width, height }
  }
  return undefined
}

/**
 * Read the pixel size of one PNG, JPEG, WebP, or GIF image from its header.
 * @param data - complete image bytes, exactly as the provider returned them.
 * @returns the pixel size, or undefined when the header is not recognized.
 */
export function imageDimensions(data: Uint8Array): ImageDimensions | undefined {
  // PNG: the IHDR chunk always starts at byte 8, with width/height at 16/20.
  if (startsWith(data, 1, 'PNG') && data.byteLength >= 24) {
    const width = be32(data, 16)
    const height = be32(data, 20)
    return width > 0 && height > 0 ? { width, height } : undefined
  }
  // GIF: logical screen descriptor, little-endian.
  if ((startsWith(data, 0, 'GIF87a') || startsWith(data, 0, 'GIF89a')) && data.byteLength >= 10) {
    const width = le16(data, 6)
    const height = le16(data, 8)
    return width > 0 && height > 0 ? { width, height } : undefined
  }
  // JPEG: walk the segment chain to the first start-of-frame marker.
  if (data.byteLength >= 4 && data[0] === 0xff && data[1] === 0xd8) return jpegDimensions(data)
  if (startsWith(data, 0, 'RIFF') && startsWith(data, 8, 'WEBP')) return webpDimensions(data)
  return undefined
}

/** File extension for one supported media type. */
export function extensionFor(mediaType: string): string {
  switch (mediaType) {
    case 'image/png': return 'png'
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    default: return 'img'
  }
}
