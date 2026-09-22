import sharp from 'sharp'
import {
  BROWSER_CAPTURE_DEVICE_SCALE,
  BROWSER_CAPTURE_MAX_BYTES,
  BROWSER_CAPTURE_MAX_LONG_EDGE,
  BROWSER_CAPTURE_MAX_PIXELS
} from '../../shared/browser'

export interface ConstrainedCapture {
  readonly mimeType: string
  readonly base64: string
  readonly width: number
  readonly height: number
  readonly bytes: number
}

function targetSize(width: number, height: number): { width: number; height: number } {
  let nextWidth = Math.max(1, Math.round(width / BROWSER_CAPTURE_DEVICE_SCALE))
  let nextHeight = Math.max(1, Math.round(height / BROWSER_CAPTURE_DEVICE_SCALE))
  const longEdge = Math.max(nextWidth, nextHeight)
  if (longEdge > BROWSER_CAPTURE_MAX_LONG_EDGE) {
    const scale = BROWSER_CAPTURE_MAX_LONG_EDGE / longEdge
    nextWidth = Math.max(1, Math.round(nextWidth * scale))
    nextHeight = Math.max(1, Math.round(nextHeight * scale))
  }
  const pixels = nextWidth * nextHeight
  if (pixels > BROWSER_CAPTURE_MAX_PIXELS) {
    const scale = Math.sqrt(BROWSER_CAPTURE_MAX_PIXELS / pixels)
    nextWidth = Math.max(1, Math.round(nextWidth * scale))
    nextHeight = Math.max(1, Math.round(nextHeight * scale))
  }
  return { width: nextWidth, height: nextHeight }
}

async function encodePng(input: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(input)
    .resize(width, height, { kernel: 'lanczos3' })
    .png()
    .toBuffer()
}

async function encodeJpeg(input: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(input)
    .resize(width, height, { kernel: 'lanczos3' })
    .jpeg({ quality: 70 })
    .toBuffer()
}

/**
 * 把宿主截图压进预算：DPR=1 的像素约束、长边、2MP、单张 1MiB。
 * 超限只允许一次降尺寸/质量重试；仍超则失败，不继续缩小。
 */
export async function constrainBrowserCapture(
  pngBase64: string
): Promise<ConstrainedCapture | null> {
  try {
    const input = Buffer.from(pngBase64, 'base64')
    const metadata = await sharp(input).metadata()
    const width = metadata.width ?? 0
    const height = metadata.height ?? 0
    if (width < 1 || height < 1) return null
    const size = targetSize(width, height)
    const png = await encodePng(input, size.width, size.height)
    if (png.byteLength <= BROWSER_CAPTURE_MAX_BYTES) {
      return {
        mimeType: 'image/png',
        base64: png.toString('base64'),
        width: size.width,
        height: size.height,
        bytes: png.byteLength
      }
    }
    const jpeg = await encodeJpeg(input, size.width, size.height)
    if (jpeg.byteLength <= BROWSER_CAPTURE_MAX_BYTES) {
      return {
        mimeType: 'image/jpeg',
        base64: jpeg.toString('base64'),
        width: size.width,
        height: size.height,
        bytes: jpeg.byteLength
      }
    }
    return null
  } catch (error) {
    console.error('[browser_capture] 截图压缩失败:', error)
    return null
  }
}
