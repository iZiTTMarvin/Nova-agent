/**
 * 图片缩放工具 — 基于 sharp 实现
 *
 * 对齐 pi-main 的 resizeImage 接口设计：
 * - 最大尺寸 2000×2000（Lanczos3 采样）
 * - 最大 base64 编码体积 4.5MB
 * - EXIF 方向自动修正
 * - JPEG 质量自动调节（80 → 55 → 40）
 * - 缩放失败时返回 null，由调用方决定回退策略
 */
import sharp from 'sharp'

/** 缩放配置 */
export interface ImageResizeOptions {
  /** 最大宽度，默认 2000 */
  maxWidth?: number
  /** 最大高度，默认 2000 */
  maxHeight?: number
  /**
   * base64 编码后的最大体积（字节）。
   * 默认 4.5MB，在 Anthropic 5MB 限制内留出安全余量。
   */
  maxBytes?: number
  /** JPEG 输出质量，默认 80 */
  jpegQuality?: number
}

/** 缩放结果 */
export interface ResizedImage {
  /** base64 编码的图片数据 */
  data: string
  /** 输出 MIME 类型 */
  mimeType: string
  /** 原始宽度 */
  originalWidth: number
  /** 原始高度 */
  originalHeight: number
  /** 缩放后宽度 */
  width: number
  /** 缩放后高度 */
  height: number
  /** 是否发生了缩放 */
  wasResized: boolean
}

const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024
const DEFAULT_MAX_WIDTH = 2000
const DEFAULT_MAX_HEIGHT = 2000
const DEFAULT_JPEG_QUALITY = 80

/**
 * 将图片缩放到指定范围内。
 *
 * 策略（对齐 pi-main）：
 * 1. 自动修正 EXIF 方向
 * 2. 如果原图已满足所有约束 → 直接返回 base64
 * 3. 按最大尺寸等比缩放
 * 4. 先尝试 PNG，再尝试不同 JPEG 质量，选最小结果
 * 5. 如果仍超限，逐步缩小尺寸重试
 * 6. 缩小到 1×1 仍超限 → 返回 null
 */
export async function resizeImage(
  inputBytes: Uint8Array,
  mimeType: string,
  options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
  const maxWidth = options?.maxWidth ?? DEFAULT_MAX_WIDTH
  const maxHeight = options?.maxHeight ?? DEFAULT_MAX_HEIGHT
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES
  const jpegQuality = options?.jpegQuality ?? DEFAULT_JPEG_QUALITY

  try {
    const pipeline = sharp(inputBytes)
      .rotate() // 自动修正 EXIF 方向

    const metadata = await pipeline.metadata()
    const originalWidth = metadata.width ?? 0
    const originalHeight = metadata.height ?? 0
    if (originalWidth === 0 || originalHeight === 0) return null

    // 原图 base64 大小估算（实际 base64 ≈ 原始大小 × 4/3）
    const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4

    // 如果原图已满足所有约束，直接编码返回
    if (
      originalWidth <= maxWidth &&
      originalHeight <= maxHeight &&
      inputBase64Size < maxBytes
    ) {
      const data = Buffer.from(inputBytes).toString('base64')
      return {
        data,
        mimeType,
        originalWidth,
        originalHeight,
        width: originalWidth,
        height: originalHeight,
        wasResized: false,
      }
    }

    // 计算目标尺寸（等比缩放）
    let targetWidth = originalWidth
    let targetHeight = originalHeight
    if (targetWidth > maxWidth) {
      targetHeight = Math.round((targetHeight * maxWidth) / targetWidth)
      targetWidth = maxWidth
    }
    if (targetHeight > maxHeight) {
      targetWidth = Math.round((targetWidth * maxHeight) / targetHeight)
      targetHeight = maxHeight
    }

    // 质量递减尝试（对齐 pi-main 的 qualitySteps）
    const qualitySteps = [...new Set([jpegQuality, 85, 70, 55, 40])]

    // 逐步缩小尺寸重试
    let currentWidth = targetWidth
    let currentHeight = targetHeight

    while (true) {
      const candidates = await tryEncodings(inputBytes, currentWidth, currentHeight, qualitySteps)
      for (const candidate of candidates) {
        if (candidate.encodedSize < maxBytes) {
          return {
            data: candidate.data,
            mimeType: candidate.mimeType,
            originalWidth,
            originalHeight,
            width: currentWidth,
            height: currentHeight,
            wasResized: currentWidth !== originalWidth || currentHeight !== originalHeight,
          }
        }
      }

      if (currentWidth === 1 && currentHeight === 1) break

      const nextWidth = currentWidth === 1 ? 1 : Math.max(1, Math.floor(currentWidth * 0.75))
      const nextHeight = currentHeight === 1 ? 1 : Math.max(1, Math.floor(currentHeight * 0.75))
      if (nextWidth === currentWidth && nextHeight === currentHeight) break

      currentWidth = nextWidth
      currentHeight = nextHeight
    }

    return null
  } catch {
    return null
  }
}

interface EncodedCandidate {
  data: string
  encodedSize: number
  mimeType: string
}

/** 尝试 PNG 和多种 JPEG 质量编码，返回所有候选 */
async function tryEncodings(
  inputBytes: Uint8Array,
  width: number,
  height: number,
  jpegQualities: number[],
): Promise<EncodedCandidate[]> {
  const candidates: EncodedCandidate[] = []

  // PNG 编码
  const pngBuf = await sharp(inputBytes)
    .rotate()
    .resize(width, height, { kernel: 'lanczos3' })
    .png()
    .toBuffer()
  candidates.push(encodeCandidate(pngBuf, 'image/png'))

  // 多质量 JPEG 编码
  for (const quality of jpegQualities) {
    const jpegBuf = await sharp(inputBytes)
      .rotate()
      .resize(width, height, { kernel: 'lanczos3' })
      .jpeg({ quality })
      .toBuffer()
    candidates.push(encodeCandidate(jpegBuf, 'image/jpeg'))
  }

  return candidates
}

function encodeCandidate(buffer: Buffer, mimeType: string): EncodedCandidate {
  const data = buffer.toString('base64')
  return {
    data,
    encodedSize: Buffer.byteLength(data, 'utf-8'),
    mimeType,
  }
}

/**
 * 生成维度映射提示（对齐 pi-main 的 formatDimensionNote）。
 * 告诉模型图片被缩放过，需要按比例映射坐标到原始尺寸。
 */
export function formatDimensionNote(result: ResizedImage): string | undefined {
  if (!result.wasResized) return undefined
  const scale = result.originalWidth / result.width
  return `[图片: 原始 ${result.originalWidth}x${result.originalHeight}，显示 ${result.width}x${result.height}。坐标映射到原始图片需乘以 ${scale.toFixed(2)}。]`
}
