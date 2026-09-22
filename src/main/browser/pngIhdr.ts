/**
 * 截图只认 PNG 头里的宽高。
 * 调用方用它判断 capturePage 是否真的交出了一张图，不凭空把空缓冲当成成功。
 */

export interface PngSize {
  readonly width: number
  readonly height: number
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function readPngIhdr(bytes: Buffer): PngSize | null {
  if (bytes.length < 24) return null
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (width === 0 || height === 0) return null
  return { width, height }
}
