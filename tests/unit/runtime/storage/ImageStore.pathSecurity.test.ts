import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ImageStore, NOVA_IMAGE_SCHEME } from '../../../../src/runtime/storage/ImageStore'

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGawjM9AQAAAABJRU5ErkJggg=='

describe('ImageStore 路径安全', () => {
  let tmpDir: string
  let store: ImageStore

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-image-sec-'))
    store = new ImageStore(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('save 拒绝畸形 sessionId', () => {
    it('../../ 逃逸被拒', () => {
      expect(() => store.save('../../etc', PNG_DATA_URL, 'image/png')).toThrow(/非法 sessionId/)
      // 确保未在 tmpDir 之外创建文件
      expect(fs.existsSync(path.join(tmpDir, '..', 'etc'))).toBe(false)
    })

    it('含路径分隔符被拒', () => {
      expect(() => store.save('sess/evil', PNG_DATA_URL, 'image/png')).toThrow(/非法 sessionId/)
      expect(() => store.save('sess\\evil', PNG_DATA_URL, 'image/png')).toThrow(/非法 sessionId/)
    })

    it('空字符串被拒', () => {
      expect(() => store.save('', PNG_DATA_URL, 'image/png')).toThrow(/非法 sessionId/)
    })
  })

  describe('resolveUrl 拒绝路径逃逸', () => {
    it('畸形 sessionId 返回 null', () => {
      expect(store.resolveUrl(`${NOVA_IMAGE_SCHEME}://../../etc/passwd`)).toBeNull()
      expect(store.resolveUrl(`${NOVA_IMAGE_SCHEME}://sess/x/evil`)).toBeNull()
    })

    it('hash 段含 .. 返回 null', () => {
      // nova-image://sess_x/../../etc/passwd
      const malicious = `${NOVA_IMAGE_SCHEME}://sess_x/..%2F..%2Fetc%2Fpasswd`
      expect(store.resolveUrl(malicious)).toBeNull()
    })

    it('hash 段含未知扩展名返回 null', () => {
      expect(store.resolveUrl(`${NOVA_IMAGE_SCHEME}://sess_x/abc123.exe`)).toBeNull()
      expect(store.resolveUrl(`${NOVA_IMAGE_SCHEME}://sess_x/abc123.sh`)).toBeNull()
    })

    it('hash 段含路径分隔符返回 null', () => {
      expect(store.resolveUrl(`${NOVA_IMAGE_SCHEME}://sess_x/abc/evil.png`)).toBeNull()
    })

    it('非 nova-image scheme 返回 null', () => {
      expect(store.resolveUrl('https://example.com/x.png')).toBeNull()
      expect(store.resolveUrl('file:///C:/x.png')).toBeNull()
    })

    it('合法 URL 正确解析', () => {
      const saved = store.save('sess_ok', PNG_DATA_URL, 'image/png')
      const resolved = store.resolveUrl(saved.url)
      expect(resolved).not.toBeNull()
      expect(resolved!.filePath).toBe(saved.filePath)
    })

    it('resolveUrl 不读取文件系统（纯解析）', () => {
      // 不存在的 hash 但格式合法，resolveUrl 仍应返回路径（读盘与否由协议 handler 决定）
      const resolved = store.resolveUrl(`${NOVA_IMAGE_SCHEME}://sess_ok/deadbeef.png`)
      expect(resolved).not.toBeNull()
      expect(fs.existsSync(resolved!.filePath)).toBe(false)
    })
  })

  describe('exists 拒绝畸形输入', () => {
    it('畸形 sessionId 返回 false 而非抛错', () => {
      expect(store.exists('../../etc', 'abc.png')).toBe(false)
      expect(store.exists('sess/evil', 'abc.png')).toBe(false)
    })

    it('畸形 hash 文件名返回 false', () => {
      expect(store.exists('sess_ok', '../../etc')).toBe(false)
      expect(store.exists('sess_ok', 'abc.exe')).toBe(false)
    })
  })
})
