import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { SessionStore } from '../../../../src/runtime/sessions/SessionStore'
import type { Mode } from '../../../../src/shared/session'

/** 创建临时目录用于测试 */
let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-session-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('SessionStore', () => {
  describe('create', () => {
    it('创建新会话并返回完整数据', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')

      expect(session.id).toMatch(/^sess_/)
      expect(session.workspaceRoot).toBe('/project/root')
      expect(session.mode).toBe('default')
      expect(session.messages).toHaveLength(0)
      expect(session.createdAt).toBeGreaterThan(0)
      expect(session.updatedAt).toBe(session.createdAt)
    })

    it('创建会话时可以指定模式', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root', 'auto' as Mode)

      expect(session.mode).toBe('auto')
    })

    it('创建后会话数据保存到磁盘', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')

      const sessionDir = path.join(tmpDir, 'sessions', session.id)
      expect(fs.existsSync(sessionDir)).toBe(true)

      const filePath = path.join(sessionDir, 'session.json')
      expect(fs.existsSync(filePath)).toBe(true)

      const content = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      expect(content.id).toBe(session.id)
    })
  })

  describe('load', () => {
    it('加载存在的会话', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      const loaded = store.load(session.id)

      expect(loaded).not.toBeNull()
      expect(loaded!.id).toBe(session.id)
      expect(loaded!.workspaceRoot).toBe('/project/root')
    })

    it('加载不存在的会话返回 null', () => {
      const store = new SessionStore(tmpDir)
      const loaded = store.load('non-existent-id')
      expect(loaded).toBeNull()
    })

    it('加载含消息的会话', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      store.appendMessage(session.id, {
        id: 'msg_1',
        role: 'user',
        content: 'hello',
        timestamp: Date.now()
      })

      const loaded = store.load(session.id)
      expect(loaded!.messages).toHaveLength(1)
      expect(loaded!.messages[0].content).toBe('hello')
    })
  })

  describe('list', () => {
    it('空目录返回空列表', () => {
      const store = new SessionStore(tmpDir)
      expect(store.list()).toHaveLength(0)
    })

    it('返回所有会话摘要按 updatedAt 降序排列', () => {
      const store = new SessionStore(tmpDir)
      const s1 = store.create('/project/a')
      const s2 = store.create('/project/b')

      const list = store.list()
      expect(list).toHaveLength(2)
      // 新创建的排在前面（updatedAt 降序）
      expect(list[0].id).toBe(s2.id)
      expect(list[1].id).toBe(s1.id)
    })

    it('摘要不含消息体但含正确消息数', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      store.appendMessage(session.id, {
        id: 'msg_1',
        role: 'user',
        content: 'hello',
        timestamp: Date.now()
      })

      const list = store.list()
      expect(list[0].messageCount).toBe(1)
    })
  })

  describe('delete', () => {
    it('删除存在的会话返回 true', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')

      expect(store.delete(session.id)).toBe(true)
      expect(store.load(session.id)).toBeNull()
    })

    it('删除不存在的会话返回 false', () => {
      const store = new SessionStore(tmpDir)
      expect(store.delete('non-existent')).toBe(false)
    })

    it('删除后会话目录从磁盘移除', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      const sessionDir = path.join(tmpDir, 'sessions', session.id)

      expect(fs.existsSync(sessionDir)).toBe(true)
      store.delete(session.id)
      expect(fs.existsSync(sessionDir)).toBe(false)
    })
  })

  describe('appendMessage', () => {
    it('追加消息到会话并自动更新 updatedAt', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      const originalUpdatedAt = session.updatedAt

      // 确保有微小时间差
      const result = store.appendMessage(session.id, {
        id: 'msg_1',
        role: 'user',
        content: 'hello',
        timestamp: Date.now()
      })

      expect(result).not.toBeNull()
      expect(result!.messages).toHaveLength(1)
      expect(result!.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt)
    })

    it('追加消息到不存在的会话返回 null', () => {
      const store = new SessionStore(tmpDir)
      const result = store.appendMessage('non-existent', {
        id: 'msg_1',
        role: 'user',
        content: 'hello',
        timestamp: Date.now()
      })
      expect(result).toBeNull()
    })

    it('追加多条消息', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')

      store.appendMessage(session.id, {
        id: 'msg_1',
        role: 'user',
        content: 'hello',
        timestamp: Date.now()
      })
      store.appendMessage(session.id, {
        id: 'msg_2',
        role: 'assistant',
        content: 'world',
        timestamp: Date.now()
      })

      const loaded = store.load(session.id)
      expect(loaded!.messages).toHaveLength(2)
    })
  })

  describe('updateMode', () => {
    it('更新会话模式并持久化到磁盘', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root', 'default')

      const updated = store.updateMode(session.id, 'auto')

      expect(updated).not.toBeNull()
      expect(updated!.mode).toBe('auto')
      expect(store.load(session.id)!.mode).toBe('auto')
    })

    it('更新不存在的会话模式返回 null', () => {
      const store = new SessionStore(tmpDir)
      expect(store.updateMode('missing-session', 'plan')).toBeNull()
    })
  })

  describe('save', () => {
    it('保存覆盖已有数据', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')

      // 修改并保存
      session.workspaceRoot = '/updated/path'
      store.save(session)

      const loaded = store.load(session.id)
      expect(loaded!.workspaceRoot).toBe('/updated/path')
    })
  })

  describe('getSessionsDir', () => {
    it('返回正确的 sessions 目录路径', () => {
      const store = new SessionStore(tmpDir)
      expect(store.getSessionsDir()).toBe(path.join(tmpDir, 'sessions'))
    })
  })
})
