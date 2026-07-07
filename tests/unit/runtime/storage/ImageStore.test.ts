import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ImageStore, NOVA_IMAGE_SCHEME } from '../../../../src/runtime/storage/ImageStore'

// 1x1 红点 PNG（固定内容，便于断言 hash 稳定）
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGawjM9AQAAAABJRU5ErkJggg=='
// 1x1 蓝点 PNG（不同内容，用于测去重区分）
const PNG_DATA_URL_2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAENwBGp9K3AAAAAElFTkSuQmCC'

describe('ImageStore', () => {
  let tmpDir: string
  let store: ImageStore

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-image-store-'))
    store = new ImageStore(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('save', () => {
    it('落盘后返回 nova-image:// URL，文件存在且内容正确', () => {
      const result = store.save('sess_test1', PNG_DATA_URL, 'image/png')

      expect(result.url.startsWith(`${NOVA_IMAGE_SCHEME}://sess_test1/`)).toBe(true)
      expect(result.url.endsWith('.png')).toBe(true)
      expect(result.bytes).toBeGreaterThan(0)
      expect(result.deduplicated).toBe(false)

      // 文件确实存在
      expect(fs.existsSync(result.filePath)).toBe(true)
      // 内容是原始二进制（非 base64 文本）
      const content = fs.readFileSync(result.filePath)
      expect(content.length).toBe(result.bytes)
    })

    it('相同内容重复 save 命中去重（不重复写盘）', () => {
      const r1 = store.save('sess_test2', PNG_DATA_URL, 'image/png')
      const r2 = store.save('sess_test2', PNG_DATA_URL, 'image/png')

      expect(r1.hash).toBe(r2.hash)
      expect(r1.filePath).toBe(r2.filePath)
      expect(r1.url).toBe(r2.url)
      expect(r1.deduplicated).toBe(false)
      expect(r2.deduplicated).toBe(true) // 第二次命中去重
    })

    it('不同内容生成不同 hash（不误去重）', () => {
      const r1 = store.save('sess_test3', PNG_DATA_URL, 'image/png')
      const r2 = store.save('sess_test3', PNG_DATA_URL_2, 'image/png')

      expect(r1.hash).not.toBe(r2.hash)
      expect(r1.filePath).not.toBe(r2.filePath)
    })

    it('不同会话的同内容图片各自独立落盘', () => {
      const r1 = store.save('sess_a', PNG_DATA_URL, 'image/png')
      const r2 = store.save('sess_b', PNG_DATA_URL, 'image/png')

      // hash 相同（内容一致），但路径与 URL 因 sessionId 不同而不同
      expect(r1.hash).toBe(r2.hash)
      expect(r1.filePath).not.toBe(r2.filePath)
      expect(r1.url).not.toBe(r2.url)
    })

    it('按 MIME 推导扩展名：jpeg/gif/webp', () => {
      // 构造最小合法各格式 data URL（内容不一定是真图，仅测扩展名推导）
      const jpeg = store.save('sess_ext', 'data:image/jpeg;base64,/9j/4AAQ', 'image/jpeg')
      const gif = store.save('sess_ext', 'data:image/gif;base64,R0lGODlh', 'image/gif')
      const webp = store.save('sess_ext', 'data:image/webp;base64,UklGRiQ', 'image/webp')

      expect(jpeg.url.endsWith('.jpg')).toBe(true)
      expect(gif.url.endsWith('.gif')).toBe(true)
      expect(webp.url.endsWith('.webp')).toBe(true)
    })
  })

  describe('resolveUrl', () => {
    it('合法 URL 正确解析为绝对路径', () => {
      const saved = store.save('sess_resolve', PNG_DATA_URL, 'image/png')
      const resolved = store.resolveUrl(saved.url)

      expect(resolved).not.toBeNull()
      expect(resolved!.filePath).toBe(saved.filePath)
      expect(resolved!.mimeType).toBe('image/png')
    })

    it('resolveUrl 与 save 往返一致', () => {
      const saved = store.save('sess_round', PNG_DATA_URL, 'image/png')
      const resolved = store.resolveUrl(saved.url)
      expect(resolved!.filePath).toBe(saved.filePath)
    })
  })

  describe('exists', () => {
    it('已落盘的 hash 返回 true', () => {
      const saved = store.save('sess_exist', PNG_DATA_URL, 'image/png')
      const fileName = path.basename(saved.filePath)
      expect(store.exists('sess_exist', fileName)).toBe(true)
    })

    it('未落盘的 hash 返回 false', () => {
      expect(store.exists('sess_exist', 'nonexistent.png')).toBe(false)
    })
  })

  describe('save 错误输入', () => {
    it('非 base64 data URL 抛错', () => {
      expect(() => store.save('sess_err', 'https://example.com/x.png', 'image/png')).toThrow(/base64 data URL/)
    })

    it('非法 sessionId 抛错', () => {
      expect(() => store.save('../escape', PNG_DATA_URL, 'image/png')).toThrow(/非法 sessionId/)
    })
  })

  describe('读盘往返（save → resolveUrl → 读回 base64）', () => {
    it('落盘的图片能被 resolveUrl 定位并由 fs 读回，base64 与原始一致', () => {
      // 模拟 agentHandler.resolveToDataUrl 的核心逻辑：
      // save → resolveUrl → fs.readFileSync → base64 编码
      const saved = store.save('sess_roundtrip', PNG_DATA_URL, 'image/png')
      const resolved = store.resolveUrl(saved.url)

      expect(resolved).not.toBeNull()
      const buffer = fs.readFileSync(resolved!.filePath)
      const roundtripDataUrl = `data:${resolved!.mimeType};base64,${buffer.toString('base64')}`

      // 往返后的 data URL 与原始一致（证明落盘内容无损坏）
      expect(roundtripDataUrl).toBe(PNG_DATA_URL)
    })

    it('resolveUrl 定位到不存在的文件时 fs 读取抛 ENOENT（由调用方兜底）', () => {
      const resolved = store.resolveUrl(`${NOVA_IMAGE_SCHEME}://sess_roundtrip/deadbeef.png`)
      expect(resolved).not.toBeNull()
      expect(() => fs.readFileSync(resolved!.filePath)).toThrow(/ENOENT/)
    })
  })
})
