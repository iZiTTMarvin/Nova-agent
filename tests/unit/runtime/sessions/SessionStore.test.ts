import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { SessionStore } from '../../../../src/runtime/sessions/SessionStore'
import { CURRENT_SESSION_SCHEMA_VERSION } from '../../../../src/runtime/sessions/migrations'
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
      expect(session.currentLeafId).toBeNull()
      expect(session.title).toBe('新会话')
      expect(session.titleSource).toBe('placeholder')
      expect(session.createdAt).toBeGreaterThan(0)
      expect(session.updatedAt).toBe(session.createdAt)
    })

    it('创建会话时可以指定模式', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root', 'compose' as Mode)

      expect(session.mode).toBe('compose')
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

    it('返回所有会话摘要按 updatedAt 降序排列', async () => {
      const store = new SessionStore(tmpDir)
      const s1 = store.create('/project/a')
      // 确保 s2 的 updatedAt 严格大于 s1，避免 Date.now() 相同导致排序不稳定
      await new Promise(r => setTimeout(r, 15))
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

    it('追加消息自动设置 parentId 链并推进 currentLeafId', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')

      store.appendMessage(session.id, {
        id: 'msg_1',
        role: 'user',
        content: 'hello',
        timestamp: 1
      })
      store.appendMessage(session.id, {
        id: 'msg_2',
        role: 'assistant',
        content: 'world',
        timestamp: 2
      })

      const loaded = store.load(session.id)!
      expect(loaded.messages[0].parentId).toBe(null)
      expect(loaded.messages[1].parentId).toBe('msg_1')
      expect(loaded.currentLeafId).toBe('msg_2')

      const meta = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'sessions', session.id, 'session.json'), 'utf8')
      )
      expect(meta.currentLeafId).toBe('msg_2')
    })
  })

  describe('setCurrentLeaf', () => {
    it('倒回 null 后激活路径为空，下次 append 挂为新根', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')

      store.appendMessage(session.id, {
        id: 'u1',
        role: 'user',
        content: 'hello',
        timestamp: 1
      })
      store.appendMessage(session.id, {
        id: 'a1',
        role: 'assistant',
        content: 'world',
        timestamp: 2
      })

      store.setCurrentLeaf(session.id, null)

      const afterFork = store.load(session.id)!
      expect(afterFork.currentLeafId).toBe(null)
      expect(afterFork.messages).toHaveLength(2)

      store.appendMessage(session.id, {
        id: 'u2',
        role: 'user',
        content: 'hello again',
        timestamp: 3
      })

      const loaded = store.load(session.id)!
      expect(loaded.messages).toHaveLength(3)
      const u2 = loaded.messages.find(m => m.id === 'u2')!
      expect(u2.parentId).toBe(null)
      expect(loaded.currentLeafId).toBe('u2')
    })

    it('倒回到中间节点后下次 append 挂为其子节点', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')

      store.appendMessage(session.id, { id: 'u1', role: 'user', content: 'a', timestamp: 1 })
      store.appendMessage(session.id, { id: 'a1', role: 'assistant', content: 'b', timestamp: 2 })
      store.appendMessage(session.id, { id: 'u2', role: 'user', content: 'c', timestamp: 3 })

      store.setCurrentLeaf(session.id, 'a1')
      store.appendMessage(session.id, { id: 'a1b', role: 'assistant', content: 'branch', timestamp: 4 })

      const loaded = store.load(session.id)!
      const branch = loaded.messages.find(m => m.id === 'a1b')!
      expect(branch.parentId).toBe('a1')
      expect(loaded.currentLeafId).toBe('a1b')
    })
  })

  describe('updateMode', () => {
    it('更新会话模式并持久化到磁盘', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root', 'default')

      const updated = store.updateMode(session.id, 'compose')

      expect(updated).not.toBeNull()
      expect(updated!.mode).toBe('compose')
      expect(store.load(session.id)!.mode).toBe('compose')
    })

    it('更新不存在的会话模式返回 null', () => {
      const store = new SessionStore(tmpDir)
      expect(store.updateMode('missing-session', 'plan')).toBeNull()
    })
  })

  describe('updateTitle', () => {
    it('自动生成标题写入并持久化', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')

      const updated = store.updateTitle(session.id, '帮我写登录页', 'generated')

      expect(updated!.title).toBe('帮我写登录页')
      expect(updated!.titleSource).toBe('generated')
      expect(store.load(session.id)!.title).toBe('帮我写登录页')
    })

    it('manual 标题后 generated 不再覆盖', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')

      store.updateTitle(session.id, '自定义标题', 'manual')
      const after = store.updateTitle(session.id, '自动标题', 'generated')

      expect(after!.title).toBe('自定义标题')
      expect(after!.titleSource).toBe('manual')
    })

    it('list 摘要透传 title 字段', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      store.updateTitle(session.id, '列表标题', 'generated')

      const summaries = store.list()
      const found = summaries.find(s => s.id === session.id)
      expect(found?.title).toBe('列表标题')
      expect(found?.titleSource).toBe('generated')
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

  describe('grantedSkillRoots 持久化', () => {
    it('addGrantedSkillRoot 幂等写入并跨 load 恢复', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      const root = '/skills/nova-frontend'

      const once = store.addGrantedSkillRoot(session.id, root)
      expect(once?.grantedSkillRoots).toEqual([root])

      const twice = store.addGrantedSkillRoot(session.id, root)
      expect(twice?.grantedSkillRoots).toEqual([root])

      const reloaded = store.load(session.id)
      expect(reloaded?.grantedSkillRoots).toEqual([root])
      expect(reloaded?.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION)
    })

    it('空白路径忽略', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      store.addGrantedSkillRoot(session.id, '   ')
      expect(store.load(session.id)?.grantedSkillRoots).toBeUndefined()
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

  describe('JSONL 追加存储', () => {
    it('appendMessage 后消息写入 messages.jsonl，session.json 只含元数据', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      store.appendMessage(session.id, {
        id: 'msg_1',
        role: 'user',
        content: 'hello',
        timestamp: Date.now()
      })

      const sessionDir = path.join(tmpDir, 'sessions', session.id)
      const metadata = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'))
      expect(metadata.messages).toBeUndefined()
      expect(metadata.id).toBe(session.id)

      const jsonl = fs.readFileSync(path.join(sessionDir, 'messages.jsonl'), 'utf8')
      const lines = jsonl.trim().split('\n')
      expect(lines).toHaveLength(1)
      const diskMsg = JSON.parse(lines[0])
      // v8 落盘：content 可为空，正文在 blocks；加载投影后仍可读
      expect(
        diskMsg.content === 'hello' ||
          (Array.isArray(diskMsg.blocks) &&
            diskMsg.blocks.some((b: { type: string; content?: string }) => b.type === 'text' && b.content === 'hello'))
      ).toBe(true)
      const loaded = store.load(session.id)
      expect(loaded!.messages[0].content).toBe('hello')
    })

    it('load 从 messages.jsonl 重组完整消息历史', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      store.appendMessage(session.id, { id: 'msg_1', role: 'user', content: 'a', timestamp: 1 })
      store.appendMessage(session.id, { id: 'msg_2', role: 'assistant', content: 'b', timestamp: 2 })

      const loaded = store.load(session.id)
      expect(loaded!.messages).toHaveLength(2)
      expect(loaded!.messages[0].content).toBe('a')
      expect(loaded!.messages[1].content).toBe('b')
    })

    it('messages.jsonl 存在损坏行时跳过该行', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      const sessionDir = path.join(tmpDir, 'sessions', session.id)

      store.appendMessage(session.id, { id: 'msg_1', role: 'user', content: 'ok', timestamp: 1 })
      fs.appendFileSync(path.join(sessionDir, 'messages.jsonl'), 'not-valid-json\n', 'utf8')

      const loaded = store.load(session.id)
      expect(loaded!.messages).toHaveLength(1)
      expect(loaded!.messages[0].content).toBe('ok')
    })

    it('save 重写 messages.jsonl 实现截断回退', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      store.appendMessage(session.id, { id: 'msg_1', role: 'user', content: 'a', timestamp: 1 })
      store.appendMessage(session.id, { id: 'msg_2', role: 'assistant', content: 'b', timestamp: 2 })

      const loaded = store.load(session.id)!
      loaded.messages = loaded.messages.slice(0, 1)
      store.save(loaded)

      const reloaded = store.load(session.id)
      expect(reloaded!.messages).toHaveLength(1)
      expect(reloaded!.messages[0].id).toBe('msg_1')
    })

    it('updateTodos 只改 session.json，不碰 messages.jsonl', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      store.appendMessage(session.id, { id: 'msg_1', role: 'user', content: 'a', timestamp: 1 })

      const sessionDir = path.join(tmpDir, 'sessions', session.id)
      const jsonlBefore = fs.readFileSync(path.join(sessionDir, 'messages.jsonl'), 'utf8')

      store.updateTodos(session.id, [{ content: 'todo', status: 'pending', priority: 'high' }])

      const jsonlAfter = fs.readFileSync(path.join(sessionDir, 'messages.jsonl'), 'utf8')
      expect(jsonlAfter).toBe(jsonlBefore)

      const metadata = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'))
      expect(metadata.todos).toHaveLength(1)
    })

    it('updateMode 只改 session.json，不碰 messages.jsonl', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      store.appendMessage(session.id, { id: 'msg_1', role: 'user', content: 'a', timestamp: 1 })

      const sessionDir = path.join(tmpDir, 'sessions', session.id)
      const jsonlBefore = fs.readFileSync(path.join(sessionDir, 'messages.jsonl'), 'utf8')

      store.updateMode(session.id, 'compose' as Mode)

      const jsonlAfter = fs.readFileSync(path.join(sessionDir, 'messages.jsonl'), 'utf8')
      expect(jsonlAfter).toBe(jsonlBefore)

      const metadata = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'))
      expect(metadata.mode).toBe('compose')
    })

    it('appendMessage 对未迁移的旧版会话直接追加，旧消息不丢', () => {
      const sessionId = 'sess_append_legacy'
      const sessionDir = path.join(tmpDir, 'sessions', sessionId)
      fs.mkdirSync(sessionDir, { recursive: true })

      const legacy = {
        schemaVersion: 2,
        id: sessionId,
        workspaceRoot: '/legacy',
        mode: 'default',
        messages: [
          { id: 'm1', role: 'user', content: 'legacy old', timestamp: 1 }
        ],
        createdAt: 1,
        updatedAt: 2
      }
      fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(legacy, null, 2), 'utf8')

      const store = new SessionStore(tmpDir)
      // 不先调用 load，直接 appendMessage
      store.appendMessage(sessionId, { id: 'm2', role: 'assistant', content: 'new appended', timestamp: 3 })

      const loaded = store.load(sessionId)
      expect(loaded!.messages).toHaveLength(2)
      expect(loaded!.messages[0].content).toBe('legacy old')
      expect(loaded!.messages[1].content).toBe('new appended')

      // 旧版内联消息应已拆出
      const metadata = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'))
      expect(metadata.messages).toBeUndefined()
      expect(metadata.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION)
    })
  })

  describe('旧版会话懒迁移', () => {
    it('v2 含内联 messages 的旧版 session.json 加载时自动拆出到 messages.jsonl', () => {
      const sessionId = 'sess_legacy_v2'
      const sessionDir = path.join(tmpDir, 'sessions', sessionId)
      fs.mkdirSync(sessionDir, { recursive: true })

      const legacy = {
        schemaVersion: 2,
        id: sessionId,
        workspaceRoot: '/legacy',
        mode: 'default',
        messages: [
          { id: 'm1', role: 'user', content: 'v2 message', timestamp: 1 }
        ],
        createdAt: 1,
        updatedAt: 2
      }
      fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(legacy, null, 2), 'utf8')

      const store = new SessionStore(tmpDir)
      const loaded = store.load(sessionId)
      expect(loaded!.messages).toHaveLength(1)
      expect(loaded!.messages[0].content).toBe('v2 message')
      expect(loaded!.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION)

      const metadata = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'))
      expect(metadata.messages).toBeUndefined()
      expect(metadata.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION)
    })

    it('v1 含内联 messages 的旧版 session.json 加载时自动拆出到 messages.jsonl', () => {
      const sessionId = 'sess_legacy_v1'
      const sessionDir = path.join(tmpDir, 'sessions', sessionId)
      fs.mkdirSync(sessionDir, { recursive: true })

      const legacy = {
        schemaVersion: 1,
        id: sessionId,
        workspaceRoot: '/legacy',
        mode: 'default',
        messages: [
          { id: 'm1', role: 'user', content: 'v1 message a', timestamp: 1 },
          { id: 'm2', role: 'assistant', content: 'v1 message b', timestamp: 2 }
        ],
        createdAt: 1,
        updatedAt: 2
      }
      fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(legacy, null, 2), 'utf8')

      const store = new SessionStore(tmpDir)
      const loaded = store.load(sessionId)
      expect(loaded!.messages).toHaveLength(2)
      expect(loaded!.messages[0].content).toBe('v1 message a')
      expect(loaded!.messages[1].content).toBe('v1 message b')
      expect(loaded!.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION)

      const metadata = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'))
      expect(metadata.messages).toBeUndefined()
      expect(metadata.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION)
    })

    it('无 schemaVersion 的旧版 session.json 加载时自动拆出到 messages.jsonl', () => {
      const sessionId = 'sess_legacy_v0'
      const sessionDir = path.join(tmpDir, 'sessions', sessionId)
      fs.mkdirSync(sessionDir, { recursive: true })

      const legacy = {
        id: sessionId,
        workspaceRoot: '/legacy',
        mode: 'plan',
        messages: [
          { id: 'm1', role: 'user', content: 'v0 message', timestamp: 1 }
        ],
        createdAt: 1,
        updatedAt: 2
      }
      fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(legacy, null, 2), 'utf8')

      const store = new SessionStore(tmpDir)
      const loaded = store.load(sessionId)
      expect(loaded!.messages).toHaveLength(1)
      expect(loaded!.messages[0].content).toBe('v0 message')
      expect(loaded!.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION)
      expect(loaded!.mode).toBe('plan')

      const metadata = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'))
      expect(metadata.messages).toBeUndefined()
      expect(metadata.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION)
    })

    it('v3 messages.jsonl 会话加载时迁移到 v4 并补 parentId', () => {
      const sessionId = 'sess_legacy_v3_jsonl'
      const sessionDir = path.join(tmpDir, 'sessions', sessionId)
      fs.mkdirSync(sessionDir, { recursive: true })

      const v3meta = {
        schemaVersion: 3,
        id: sessionId,
        workspaceRoot: '/legacy',
        mode: 'default',
        createdAt: 1,
        updatedAt: 2
      }
      fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(v3meta, null, 2), 'utf8')
      const jsonl = [
        JSON.stringify({ id: 'm1', role: 'user', content: 'a', timestamp: 1 }),
        JSON.stringify({ id: 'm2', role: 'assistant', content: 'b', timestamp: 2 })
      ].join('\n') + '\n'
      fs.writeFileSync(path.join(sessionDir, 'messages.jsonl'), jsonl, 'utf8')

      const store = new SessionStore(tmpDir)
      const loaded = store.load(sessionId)!
      expect(loaded.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION)
      expect(loaded.messages[0].parentId).toBe(null)
      expect(loaded.messages[1].parentId).toBe('m1')
      expect(loaded.currentLeafId).toBe('m2')
    })
  })

  describe('loadMessagesPage', () => {
    function appendMessages(store: SessionStore, sessionId: string, count: number) {
      for (let i = 0; i < count; i++) {
        store.appendMessage(sessionId, {
          id: `msg_${i}`,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `content-${i}`,
          timestamp: i + 1
        })
      }
    }

    it('空会话返回空页', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      const page = store.loadMessagesPage(session.id, { limit: 20 })
      expect(page).toEqual({ messages: [], hasMore: false })
    })

    it('无 beforeId 时返回最新 limit 条', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      appendMessages(store, session.id, 30)

      const page = store.loadMessagesPage(session.id, { limit: 20 })
      expect(page!.messages).toHaveLength(20)
      expect(page!.messages[0].id).toBe('msg_10')
      expect(page!.messages[19].id).toBe('msg_29')
      expect(page!.hasMore).toBe(true)
    })

    it('不足一页时 hasMore 为 false', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      appendMessages(store, session.id, 5)

      const page = store.loadMessagesPage(session.id, { limit: 20 })
      expect(page!.messages).toHaveLength(5)
      expect(page!.hasMore).toBe(false)
    })

    it('beforeId 返回其之前的 limit 条', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      appendMessages(store, session.id, 50)

      const page = store.loadMessagesPage(session.id, { beforeId: 'msg_30', limit: 10 })
      expect(page!.messages.map(m => m.id)).toEqual([
        'msg_20', 'msg_21', 'msg_22', 'msg_23', 'msg_24',
        'msg_25', 'msg_26', 'msg_27', 'msg_28', 'msg_29'
      ])
      expect(page!.hasMore).toBe(true)
    })

    it('beforeId 不存在时返回空且 hasMore=false', () => {
      const store = new SessionStore(tmpDir)
      const session = store.create('/project/root')
      appendMessages(store, session.id, 3)

      const page = store.loadMessagesPage(session.id, { beforeId: 'missing', limit: 10 })
      expect(page).toEqual({ messages: [], hasMore: false })
    })

    it('会话不存在返回 null', () => {
      const store = new SessionStore(tmpDir)
      expect(store.loadMessagesPage('no-such', { limit: 10 })).toBeNull()
    })
  })
})
