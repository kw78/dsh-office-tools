/**
 * Intrinsic image dimensions from file headers (1.0.0). PNG, JPEG, and GIF
 * expose their pixel size in the first few hundred of bytes, so the linked
 * image placement can default to natural size — and compute contain/cover
 * crops — by reading the workspace file through the official fs channel and
 * inspecting bytes directly. No image decoder, no dependency, no signal.
 */

/** Returned dimensions in pixels; undefined when the bytes are not a recognized image. */
export interface ImageSize {
  width: number
  height: number
}

function pngSize(bytes: Uint8Array): ImageSize | undefined {
  // 8-byte signature + IHDR length/type, then big-endian width and height.
  if (bytes.length < 24) return undefined
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return undefined
  const width = (bytes[16]! << 24 | bytes[17]! << 16 | bytes[18]! << 8 | bytes[19]!) >>> 0
  const height = (bytes[20]! << 24 | bytes[21]! << 16 | bytes[22]! << 8 | bytes[23]!) >>> 0
  return width > 0 && height > 0 ? { width, height } : undefined
}

function jpegSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  // Walk the segment stream to the first SOF marker (baseline/progressive).
  let cursor = 2
  while (cursor + 9 < bytes.length) {
    if (bytes[cursor] !== 0xff) return undefined
    const marker = bytes[cursor + 1]!
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      cursor += 2
      continue
    }
    const length = (bytes[cursor + 2]! << 8) | bytes[cursor + 3]!
    const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf)
    if (isStartOfFrame) {
      const height = (bytes[cursor + 5]! << 8) | bytes[cursor + 6]!
      const width = (bytes[cursor + 7]! << 8) | bytes[cursor + 8]!
      return width > 0 && height > 0 ? { width, height } : undefined
    }
    if (marker === 0xda) return undefined
    cursor += 2 + length
  }
  return undefined
}

function gifSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 10) return undefined
  if (bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) return undefined
  const width = bytes[6]! | (bytes[7]! << 8)
  const height = bytes[8]! | (bytes[9]! << 8)
  return width > 0 && height > 0 ? { width, height } : undefined
}

/** Sniff the pixel size of a PNG/JPEG/GIF byte buffer; undefined otherwise. */
export function sniffImageSize(bytes: Uint8Array): ImageSize | undefined {
  return pngSize(bytes) ?? jpegSize(bytes) ?? gifSize(bytes)
}
