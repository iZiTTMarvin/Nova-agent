import sharp from 'sharp'

/** 入库前触发缩图的原始图片字节上限。 */
export const MAX_IMAGE_INGEST_BYTES = 5 * 1024 * 1024
/** 模型可接受的图片长边上限。 */
export const MAX_IMAGE_EDGE = 2000

interface DecodedImage {
  buffer: Buffer
  mimeType: string
}

export interface PreparedImage {
  dataUrl: string
  mimeType: string
  bytes: number
  wasResized: boolean
}

function decodeDataUrl(dataUrl: string, fallbackMime: string): DecodedImage {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl)
  if (!match || match[2] !== ';base64') {
    throw new Error('图片数据无效，请重新选择图片后重试')
  }
  return {
    buffer: Buffer.from(match[3], 'base64'),
    mimeType: match[1] || fallbackMime || 'application/octet-stream'
  }
}

/** 按原图比例计算不超过长边上限的整数尺寸。 */
export function computeResizeDimensions(
  width: number,
  height: number,
  maxEdge = MAX_IMAGE_EDGE
): { width: number; height: number } {
  if (width <= 0 || height <= 0 || maxEdge <= 0) {
    throw new Error('图片尺寸无效')
  }
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

function mimeTypeFromFormat(format: string | undefined, fallback: string): string {
  switch (format?.toLowerCase()) {
    case 'png':
      return 'image/png'
    case 'jpeg':
    case 'jpg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    default:
      return fallback
  }
}

function outputMimeType(inputMimeType: string): 'image/png' | 'image/jpeg' {
  return inputMimeType.toLowerCase() === 'image/png' ? 'image/png' : 'image/jpeg'
}

async function encodeImage(
  input: Buffer,
  mimeType: 'image/png' | 'image/jpeg',
  width: number,
  height: number
): Promise<Buffer> {
  const pipeline = sharp(input)
    .rotate()
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
  return mimeType === 'image/png'
    ? pipeline.png().toBuffer()
    : pipeline.jpeg({ quality: 80, mozjpeg: true }).toBuffer()
}

/**
 * 检查图片元数据并在需要时重编码。未触发门槛时保留原始图片字节。
 */
export async function prepareImageForStorage(
  dataUrl: string,
  fallbackMime: string
): Promise<PreparedImage> {
  const decoded = decodeDataUrl(dataUrl, fallbackMime)

  let metadata: sharp.Metadata
  try {
    metadata = await sharp(decoded.buffer).metadata()
  } catch {
    throw new Error('图片无法读取或缩放，请选择有效的 PNG、JPEG、GIF 或 WebP 文件后重试')
  }

  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  if (width <= 0 || height <= 0) {
    throw new Error('图片缺少有效尺寸，请选择有效的 PNG、JPEG、GIF 或 WebP 文件后重试')
  }

  const actualMimeType = mimeTypeFromFormat(metadata.format, decoded.mimeType)
  const normalizedDataUrl = `data:${actualMimeType};base64,${decoded.buffer.toString('base64')}`
  const orientedWidth = metadata.orientation != null && metadata.orientation >= 5
    ? height
    : width
  const orientedHeight = metadata.orientation != null && metadata.orientation >= 5
    ? width
    : height
  const needsResize =
    decoded.buffer.length > MAX_IMAGE_INGEST_BYTES ||
    Math.max(orientedWidth, orientedHeight) > MAX_IMAGE_EDGE

  if (!needsResize) {
    return {
      dataUrl: normalizedDataUrl,
      mimeType: actualMimeType,
      bytes: decoded.buffer.length,
      wasResized: false
    }
  }

  const mimeType = outputMimeType(actualMimeType)
  const initial = computeResizeDimensions(orientedWidth, orientedHeight)
  let targetWidth = initial.width
  let targetHeight = initial.height

  while (true) {
    try {
      const encoded = await encodeImage(decoded.buffer, mimeType, targetWidth, targetHeight)
      if (encoded.length <= MAX_IMAGE_INGEST_BYTES) {
        return {
          dataUrl: `data:${mimeType};base64,${encoded.toString('base64')}`,
          mimeType,
          bytes: encoded.length,
          wasResized: true
        }
      }
    } catch {
      throw new Error('图片无法读取或缩放，请选择有效的 PNG、JPEG、GIF 或 WebP 文件后重试')
    }

    if (targetWidth === 1 && targetHeight === 1) break
    const nextWidth = targetWidth === 1 ? 1 : Math.max(1, Math.floor(targetWidth * 0.75))
    const nextHeight = targetHeight === 1 ? 1 : Math.max(1, Math.floor(targetHeight * 0.75))
    if (nextWidth === targetWidth && nextHeight === targetHeight) break
    targetWidth = nextWidth
    targetHeight = nextHeight
  }

  throw new Error('图片压缩后仍超过 5MB，请选择更小的图片后重试')
}
