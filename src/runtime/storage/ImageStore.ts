/**
 * ImageStore — 会话级图片落盘存储
 *
 * 路径：{sessionsDir}/{sessionId}/images/{hash}.{ext}
 * 文件名取图片内容的 sha256 前 32 字符，同一会话内重复粘贴天然去重。
 * 随 SessionStore.delete() 的 rmSync(recursive) 自然清理，与 artifacts/ 子目录同级、同模式。
 *
 * URL 协议：nova-image://{sessionId}/{hash}.{ext}
 * 协议 handler（main 层）通过 resolveUrl 把 URL 还原为安全绝对路径后流式读盘。
 */
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import * as path from 'path'
import { atomicWriteFileSync } from './atomicFile'

/** 协议 scheme（nova-image://） */
export const NOVA_IMAGE_SCHEME = 'nova-image'

/** sessionId 格式：sess_ + UUID 等，与 SessionStore 的 SESSION_ID_PATTERN 对齐 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/

/** hash 段格式：16 进制 + 扩展名，禁止分隔符与 .. */
const HASH_FILENAME_PATTERN = /^[a-f0-9]+\.(png|jpe?g|gif|webp)$/i

/** MIME → 扩展名映射（落盘命名用） */
const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

/** 扩展名 → MIME 映射（协议读盘时推断 Content-Type） */
const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}

/** 拒绝路径穿越：sessionId 不得含分隔符或 .. */
function assertSafeSessionId(sessionId: string): void {
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`非法 sessionId: ${sessionId}`)
  }
}

/**
 * 解析 data URL：data:{mime};base64,{payload}
 * 返回二进制 Buffer 与 MIME；非 base64 data URL 返回 null。
 */
function decodeDataUrl(dataUrl: string): { buffer: Buffer; mimeType: string } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl)
  if (!match || match[2] !== ';base64') return null
  const mimeType = match[1] || 'application/octet-stream'
  try {
    const buffer = Buffer.from(match[3], 'base64')
    return { buffer, mimeType }
  } catch {
    return null
  }
}

/** 由 MIME 推导扩展名，未知类型兜底 png */
function extFromMime(mimeType: string): string {
  return MIME_TO_EXT[mimeType.toLowerCase()] ?? 'png'
}

/** 由文件名扩展名推导 MIME，未知类型兜底 octet-stream */
export function mimeFromExt(fileName: string): string {
  const ext = path.extname(fileName).slice(1).toLowerCase()
  return EXT_TO_MIME[ext] ?? 'application/octet-stream'
}

export interface ImageSaveResult {
  /** nova-image:// URL，用于渲染层 <img src> 与持久化 */
  url: string
  /** 内容 hash（去重 key） */
  hash: string
  /** 落盘绝对路径 */
  filePath: string
  /** 字节数 */
  bytes: number
  /** 是否复用已存在文件（命中去重） */
  deduplicated: boolean
}

export interface ResolvedImageUrl {
  /** 落盘绝对路径 */
  filePath: string
  /** Content-Type */
  mimeType: string
}

export class ImageStore {
  constructor(private readonly sessionsDir: string) {}

  /** 返回会话图片目录绝对路径 */
  getImagesDir(sessionId: string): string {
    assertSafeSessionId(sessionId)
    return path.join(this.sessionsDir, sessionId, 'images')
  }

  /**
   * 保存 base64 dataUrl 到磁盘。
   * - 按内容 sha256 前 32 字符命名，同会话内重复内容天然去重（不重复写盘）
   * - 原子写（atomicWriteFileSync），崩溃不留半成品
   * - 返回 nova-image:// URL 供渲染层与持久化引用
   */
  save(sessionId: string, dataUrl: string, fallbackMime?: string): ImageSaveResult {
    assertSafeSessionId(sessionId)

    const decoded = decodeDataUrl(dataUrl)
    if (!decoded) {
      throw new Error('ImageStore.save 仅支持 base64 data URL（data:{mime};base64,...）')
    }

    const { buffer, mimeType } = decoded
    const finalMime = mimeType !== 'application/octet-stream' ? mimeType : (fallbackMime ?? mimeType)
    const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 32)
    const ext = extFromMime(finalMime)
    const fileName = `${hash}.${ext}`

    const dir = this.getImagesDir(sessionId)
    const filePath = path.join(dir, fileName)

    let deduplicated = false
    if (existsSync(filePath)) {
      // 命中去重：同会话内已落盘过完全相同内容的图片，直接复用
      deduplicated = true
    } else {
      atomicWriteFileSync(filePath, buffer)
    }

    return {
      url: this.buildUrl(sessionId, fileName),
      hash,
      filePath,
      bytes: buffer.length,
      deduplicated
    }
  }

  /** 测试某个 hash 文件是否已存在（避免重复写）。畸形输入返回 false 而非抛错 */
  exists(sessionId: string, hashWithExt: string): boolean {
    if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) return false
    if (!HASH_FILENAME_PATTERN.test(hashWithExt)) return false
    const filePath = path.join(this.getImagesDir(sessionId), hashWithExt)
    return existsSync(filePath)
  }

  /**
   * 解析 nova-image:// URL 为安全绝对路径（供协议 handler 使用）。
   *
   * 三重校验：
   * 1. sessionId 正则（防畸形 ID）
   * 2. 文件名正则（仅允许 hex + 已知图片扩展名，防 ../ 逃逸）
   * 3. resolve 后前缀比对（最终兜底，确保落在 {sessionId}/images/ 内）
   *
   * URL 形如：nova-image://sess_xxx/abc123.png
   * 注意 Electron 的 protocol.handle 会把 scheme://host/path 里的 host 当作第一段路径，
   * 这里统一用 URL 解析后再手工拼回，避免 host/path 分歧。
   */
  resolveUrl(rawUrl: string): ResolvedImageUrl | null {
    try {
      // 容忍 nova-image://sess_xxx/hash.ext 与 nova-image://sess_xxx/hash.ext 两种写法
      const normalized = rawUrl.startsWith(`${NOVA_IMAGE_SCHEME}://`)
        ? rawUrl
        : `${NOVA_IMAGE_SCHEME}://${rawUrl}`
      const parsed = new URL(normalized)
      if (parsed.protocol !== `${NOVA_IMAGE_SCHEME}:`) return null

      // host 是 sessionId，pathname 是 /{hash.ext}
      const sessionId = decodeURIComponent(parsed.hostname)
      if (!SESSION_ID_PATTERN.test(sessionId)) return null

      // pathname 形如 /abc123.png，去掉前导 /
      const fileName = decodeURIComponent(parsed.pathname).replace(/^\/+/, '')
      if (!HASH_FILENAME_PATTERN.test(fileName)) return null

      const imagesDir = this.getImagesDir(sessionId)
      const resolved = path.resolve(imagesDir, fileName)
      const normalizedDir = path.resolve(imagesDir)
      if (resolved !== normalizedDir && !resolved.startsWith(normalizedDir + path.sep)) {
        return null
      }

      return {
        filePath: resolved,
        mimeType: mimeFromExt(fileName)
      }
    } catch {
      return null
    }
  }

  /** 构造 nova-image:// URL */
  private buildUrl(sessionId: string, fileName: string): string {
    return `${NOVA_IMAGE_SCHEME}://${sessionId}/${fileName}`
  }
}
