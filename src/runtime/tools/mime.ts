/**
 * 图片 MIME 类型检测 — 基于文件头签名
 *
 * 从 pi-main 移植，一比一对齐检测逻辑：
 * - JPEG：FF D8 FF 开头（排除 JPEG XR 的 FF D8 FF F7）
 * - PNG：8 字节签名 + IHDR chunk 验证，排除 animated PNG
 * - GIF：GIF87a/GIF89a 开头
 * - WebP：RIFF...WEBP 结构
 *
 * 只需读取文件前 4100 字节即可完成所有格式判断。
 */
import { open } from 'node:fs/promises'

/** PNG 文件头 8 字节签名 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** 检测所需的最大字节数（覆盖 PNG chunk 遍历场景） */
const IMAGE_TYPE_SNIFF_BYTES = 4100

/**
 * 从 buffer 检测图片 MIME 类型。
 * 支持 JPEG、PNG（非动画）、GIF、WebP，其他返回 null。
 */
export function detectImageMimeType(buffer: Uint8Array): string | null {
  // JPEG：FF D8 FF 开头，但排除 JPEG XR（第三个字节为 F7）
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return buffer[3] === 0xf7 ? null : 'image/jpeg'
  }

  // PNG：验证签名 + IHDR chunk，排除动画 PNG
  if (startsWith(buffer, PNG_SIGNATURE)) {
    return isPng(buffer) && !isAnimatedPng(buffer) ? 'image/png' : null
  }

  // GIF：GIF87a / GIF89a
  if (startsWithAscii(buffer, 0, 'GIF')) {
    return 'image/gif'
  }

  // WebP：RIFF....WEBP
  if (startsWithAscii(buffer, 0, 'RIFF') && startsWithAscii(buffer, 8, 'WEBP')) {
    return 'image/webp'
  }

  return null
}

/**
 * 从文件路径检测图片 MIME 类型。
 * 只读取文件头部，不会加载整个文件。
 */
export async function detectImageMimeTypeFromFile(filePath: string): Promise<string | null> {
  const fileHandle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(IMAGE_TYPE_SNIFF_BYTES)
    const { bytesRead } = await fileHandle.read(buffer, 0, IMAGE_TYPE_SNIFF_BYTES, 0)
    return detectImageMimeType(buffer.subarray(0, bytesRead))
  } finally {
    await fileHandle.close()
  }
}

// ── PNG 辅助 ──────────────────────────────────────────────────────────────────

/** 验证 PNG 结构：签名后第一个 chunk 必须是 13 字节的 IHDR */
function isPng(buffer: Uint8Array): boolean {
  return (
    buffer.length >= 16 &&
    readUint32BE(buffer, PNG_SIGNATURE.length) === 13 &&
    startsWithAscii(buffer, 12, 'IHDR')
  )
}

/** 检测是否为动画 PNG（包含 acTL chunk） */
function isAnimatedPng(buffer: Uint8Array): boolean {
  let offset = PNG_SIGNATURE.length
  while (offset + 8 <= buffer.length) {
    const chunkLength = readUint32BE(buffer, offset)
    const chunkTypeOffset = offset + 4
    if (startsWithAscii(buffer, chunkTypeOffset, 'acTL')) return true
    if (startsWithAscii(buffer, chunkTypeOffset, 'IDAT')) return false

    const nextOffset = offset + 8 + chunkLength + 4
    if (nextOffset <= offset || nextOffset > buffer.length) return false
    offset = nextOffset
  }
  return false
}

// ── 字节操作辅助 ──────────────────────────────────────────────────────────────

function readUint32BE(buffer: Uint8Array, offset: number): number {
  return (
    (buffer[offset] ?? 0) * 0x1000000 +
    ((buffer[offset + 1] ?? 0) << 16) +
    ((buffer[offset + 2] ?? 0) << 8) +
    (buffer[offset + 3] ?? 0)
  )
}

function startsWith(buffer: Uint8Array, bytes: number[]): boolean {
  if (buffer.length < bytes.length) return false
  return bytes.every((byte, index) => buffer[index] === byte)
}

function startsWithAscii(buffer: Uint8Array, offset: number, text: string): boolean {
  if (buffer.length < offset + text.length) return false
  for (let i = 0; i < text.length; i++) {
    if (buffer[offset + i] !== text.charCodeAt(i)) return false
  }
  return true
}
