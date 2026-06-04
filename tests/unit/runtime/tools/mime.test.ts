import { describe, it, expect } from 'vitest'
import { detectImageMimeType } from '../../../../src/runtime/tools/mime'

describe('mime — 图片 MIME 检测', () => {
  // ── JPEG ──────────────────────────────────────────────

  describe('JPEG', () => {
    it('标准 JPEG (FF D8 FF E0) 返回 image/jpeg', () => {
      const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
      expect(detectImageMimeType(buf)).toBe('image/jpeg')
    })

    it('JPEG EXIF (FF D8 FF E1) 返回 image/jpeg', () => {
      const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x45, 0x78])
      expect(detectImageMimeType(buf)).toBe('image/jpeg')
    })

    it('JPEG XR (FF D8 FF F7) 返回 null', () => {
      const buf = Buffer.from([0xff, 0xd8, 0xff, 0xf7, 0x00, 0x00, 0x00, 0x00])
      expect(detectImageMimeType(buf)).toBeNull()
    })
  })

  // ── PNG ───────────────────────────────────────────────

  describe('PNG', () => {
    it('有效 PNG 返回 image/png', () => {
      const buf = createValidPngHeader()
      expect(detectImageMimeType(buf)).toBe('image/png')
    })

    it('缺少 IHDR 的损坏 PNG 返回 null', () => {
      const buf = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG 签名
        0x00, 0x00, 0x00, 0x01, 0x74, 0x45, 0x58, 0x74, // tEXt chunk（非 IHDR）
      ])
      expect(detectImageMimeType(buf)).toBeNull()
    })

    it('动画 PNG (含 acTL chunk) 返回 null', () => {
      const buf = createAnimatedPngHeader()
      expect(detectImageMimeType(buf)).toBeNull()
    })
  })

  // ── GIF ───────────────────────────────────────────────

  describe('GIF', () => {
    it('GIF87a 返回 image/gif', () => {
      const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
      expect(detectImageMimeType(buf)).toBe('image/gif')
    })

    it('GIF89a 返回 image/gif', () => {
      const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
      expect(detectImageMimeType(buf)).toBe('image/gif')
    })
  })

  // ── WebP ──────────────────────────────────────────────

  describe('WebP', () => {
    it('有效 WebP (RIFF...WEBP) 返回 image/webp', () => {
      const buf = Buffer.from([
        0x52, 0x49, 0x46, 0x46, // RIFF
        0x00, 0x00, 0x00, 0x00, // 文件大小
        0x57, 0x45, 0x42, 0x50, // WEBP
      ])
      expect(detectImageMimeType(buf)).toBe('image/webp')
    })

    it('RIFF 非 WEBP 返回 null', () => {
      const buf = Buffer.from([
        0x52, 0x49, 0x46, 0x46,
        0x00, 0x00, 0x00, 0x00,
        0x41, 0x56, 0x49, 0x20, // AVI (not WEBP)
      ])
      expect(detectImageMimeType(buf)).toBeNull()
    })
  })

  // ── 非图片 ──────────────────────────────────────────────

  describe('非图片', () => {
    it('纯文本返回 null', () => {
      const buf = Buffer.from('Hello, World!')
      expect(detectImageMimeType(buf)).toBeNull()
    })

    it('空 buffer 返回 null', () => {
      expect(detectImageMimeType(Buffer.alloc(0))).toBeNull()
    })

    it('PDF 返回 null', () => {
      const buf = Buffer.from('%PDF-1.4 some content')
      expect(detectImageMimeType(buf)).toBeNull()
    })
  })
})

/** 创建有效 PNG 文件头（包含 IHDR chunk） */
function createValidPngHeader(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG 签名
    0x00, 0x00, 0x00, 0x0d, // IHDR 长度 = 13
    0x49, 0x48, 0x44, 0x52, // "IHDR"
    0x00, 0x00, 0x00, 0x01, // 宽度 1
    0x00, 0x00, 0x00, 0x01, // 高度 1
    0x08, 0x02,             // 8-bit RGB
    0x00, 0x00, 0x00,       // 压缩/滤波/隔行
  ])
}

/** 创建动画 PNG 文件头（IHDR + acTL chunk） */
function createAnimatedPngHeader(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG 签名
    0x00, 0x00, 0x00, 0x0d, // IHDR 长度 = 13
    0x49, 0x48, 0x44, 0x52, // "IHDR"
    0x00, 0x00, 0x00, 0x01,
    0x00, 0x00, 0x00, 0x01,
    0x08, 0x02,
    0x00, 0x00, 0x00,
    0x90, 0x77, 0x53, 0xde, // IHDR CRC
    0x00, 0x00, 0x00, 0x08, // acTL 长度 = 8
    0x61, 0x63, 0x54, 0x4c, // "acTL"
    0x00, 0x00, 0x00, 0x02, // 帧数
    0x00, 0x00, 0x00, 0x00, // 播放次数
  ])
}
