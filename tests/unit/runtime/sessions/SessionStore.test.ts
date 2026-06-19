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

  describe('todo 持久化', () => {
    it('初始会话 getTodos 返回空数组', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      expect(store.getTodos(session.id)).toEqual([])
    })

    it('updateTodos 全量替换并返回 { session, previousTodos }', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      const todos = [
        { content: 'A', status: 'pending' as const, priority: 'high' as const },
        { content: 'B', status: 'in_progress' as const, priority: 'medium' as const }
      ]

      const result = store.updateTodos(session.id, todos)

      expect(result).not.toBeNull()
      // 返回值新结构：{ session, previousTodos }
      expect(result!.session.todos).toEqual(todos)
      expect(result!.previousTodos).toEqual([]) // 首次写入，旧值为空
      // 落盘后 getTodos 也能读出来
      expect(store.getTodos(session.id)).toEqual(todos)
    })

    it('updateTodos 写入后 JSON 包含 todos 字段', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      store.updateTodos(session.id, [
        { content: 'A', status: 'pending', priority: 'high' }
      ])

      const filePath = path.join(tmpDir, 'sessions', session.id, 'session.json')
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      expect(raw.todos).toEqual([
        { content: 'A', status: 'pending', priority: 'high' }
      ])
    })

    it('updateTodos 不存在的会话返回 null', () => {
      const store = new SessionStore(tmpDir)
      const result = store.updateTodos('non-existent', [])
      expect(result).toBeNull()
    })

    it('updateTodos 传空数组可清空 todo', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      store.updateTodos(session.id, [
        { content: 'A', status: 'pending', priority: 'high' }
      ])

      store.updateTodos(session.id, [])

      expect(store.getTodos(session.id)).toEqual([])
    })

    it('updateTodos 返回的 previousTodos 是写入前的快照（连续两次写入）', () => {
      // 验证 previousTodos 的语义：第二次调用时 previousTodos 应等于第一次写入的内容
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      const firstTodos = [{ content: 'A', status: 'pending' as const, priority: 'high' as const }]
      const secondTodos = [{ content: 'B', status: 'pending' as const, priority: 'medium' as const }]

      const firstResult = store.updateTodos(session.id, firstTodos)
      expect(firstResult!.previousTodos).toEqual([])

      const secondResult = store.updateTodos(session.id, secondTodos)
      expect(secondResult!.previousTodos).toEqual(firstTodos)
      expect(secondResult!.session.todos).toEqual(secondTodos)
    })

    it('旧会话（无 todos 字段）updateTodos 返回 previousTodos 为空数组', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')

      // 模拟旧格式：直接写一个没有 todos 字段的 session.json
      const legacySession = {
        id: session.id,
        workspaceRoot: session.workspaceRoot,
        mode: session.mode,
        messages: [],
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
      }
      const dir = path.join(tmpDir, 'sessions', session.id)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'session.json'),
        JSON.stringify(legacySession),
        'utf8'
      )

      const result = store.updateTodos(session.id, [
        { content: 'A', status: 'pending', priority: 'high' }
      ])

      // 旧格式的 todos 字段缺失，previousTodos 兜底为 []
      expect(result).not.toBeNull()
      expect(result!.previousTodos).toEqual([])
      expect(result!.session.todos).toEqual([
        { content: 'A', status: 'pending', priority: 'high' }
      ])
    })

    it('旧会话（无 todos 字段）getTodos 返回空数组', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')

      // 模拟旧格式：直接写一个没有 todos 字段的 session.json
      const legacySession = {
        id: session.id,
        workspaceRoot: session.workspaceRoot,
        mode: session.mode,
        messages: [],
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
      }
      const dir = path.join(tmpDir, 'sessions', session.id)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'session.json'),
        JSON.stringify(legacySession),
        'utf8'
      )

      expect(store.getTodos(session.id)).toEqual([])
    })
  })

  describe('artifactId 持久化', () => {
    it('含 artifactId 的 toolCall 可保存并重新加载', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')

      store.appendMessage(session.id, {
        id: 'msg_user',
        role: 'user',
        content: 'run grep',
        timestamp: Date.now()
      })
      store.appendMessage(session.id, {
        id: 'msg_asst',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: [{
          id: 'tc_grep',
          name: 'grep',
          arguments: '{"pattern":"foo"}',
          result: 'head...\nartifact://abc123def456',
          artifactId: 'abc123def456',
          truncationMeta: {
            totalBytes: 80_000,
            totalLines: 500,
            shownLines: 120,
            truncated: true
          }
        }]
      })

      const loaded = store.load(session.id)
      expect(loaded).not.toBeNull()
      const tc = loaded!.messages[1].toolCalls![0]
      expect(tc.artifactId).toBe('abc123def456')
      expect(tc.truncationMeta).toEqual({
        totalBytes: 80_000,
        totalLines: 500,
        shownLines: 120,
        truncated: true
      })
    })

    it('cancel 场景：未持久化的流式消息不入库，已落盘 artifact 文件不丢', async () => {
      const { ArtifactStore } = await import('../../../../src/runtime/artifacts/ArtifactStore')
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      const artifactStore = new ArtifactStore(store.getSessionsDir())
      const artifactId = 'cafebabefeed'

      // 模拟 bash 大输出已落盘
      const artifactDir = path.join(store.getSessionsDir(), session.id, 'artifacts')
      fs.mkdirSync(artifactDir, { recursive: true })
      fs.writeFileSync(
        path.join(artifactDir, artifactId),
        'full bash output line1\nline2\n',
        'utf8'
      )

      // 仅持久化已完成的 assistant 消息（cancel 后流式中间态不入库）
      store.appendMessage(session.id, {
        id: 'msg_done',
        role: 'assistant',
        content: 'partial reply before cancel',
        timestamp: Date.now(),
        interrupted: true,
        toolCalls: [{
          id: 'tc_bash',
          name: 'bash',
          arguments: '{"command":"echo big"}',
          result: 'truncated...\nartifact://' + artifactId,
          artifactId
        }]
      })

      const loaded = store.load(session.id)
      expect(loaded!.messages).toHaveLength(1)
      expect(loaded!.messages[0].interrupted).toBe(true)
      expect(loaded!.messages[0].toolCalls![0].artifactId).toBe(artifactId)

      // artifact 文件仍在磁盘，可被续读
      const full = await artifactStore.read(session.id, artifactId)
      expect(full).toContain('full bash output')
    })
  })

  describe('上下文快照（context-snapshot.json）', () => {
    it('saveContextSnapshot 写入后可 loadContextSnapshot 读回', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      const snapshot = {
        version: 1,
        summary: '对话摘要',
        recentMessages: [{ role: 'user' as const, content: '最近问题' }],
        lastMessageId: 'msg_anchor',
        compactionLevel: 1,
        updatedAt: Date.now()
      }

      store.saveContextSnapshot(session.id, snapshot)
      const loaded = store.loadContextSnapshot(session.id)

      expect(loaded).toEqual(snapshot)
    })

    it('版本不符的快照返回 null', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      const dir = path.join(tmpDir, 'sessions', session.id)
      fs.writeFileSync(
        path.join(dir, 'context-snapshot.json'),
        JSON.stringify({ version: 999, summary: '旧版' }),
        'utf8'
      )

      expect(store.loadContextSnapshot(session.id)).toBeNull()
    })

    it('clearContextSnapshot 后 load 返回 null', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      store.saveContextSnapshot(session.id, {
        version: 1,
        summary: '摘要',
        recentMessages: [],
        lastMessageId: '',
        compactionLevel: 0,
        updatedAt: 1
      })

      store.clearContextSnapshot(session.id)
      expect(store.loadContextSnapshot(session.id)).toBeNull()
    })
  })
})
