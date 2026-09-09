/**
 * SessionStore loadMessagesPage / loadActivePath 走 SQLite 随机读
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { SessionStore, deriveChildSessionId, __takeJsonlFullReads, __takeJsonlRangeBytesRead } from '../../../../src/runtime/sessions/SessionStore'
import { SESSION_MESSAGES_FILE } from '../../../../src/runtime/sessions/types'
import { createMemorySessionIndexDb } from '../../../../src/runtime/sessions/SessionIndexDb'
import {
  closeSessionIndex,
  getSessionIndex,
  resetSessionIndexHostForTests,
  setSessionIndexOpenFnForTests
} from '../../../../src/runtime/sessions/SessionIndexHost'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-sqlite-load-'))
  resetSessionIndexHostForTests()
  setSessionIndexOpenFnForTests(() => createMemorySessionIndexDb())
  __takeJsonlFullReads()
  __takeJsonlRangeBytesRead()
})

afterEach(() => {
  resetSessionIndexHostForTests()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('SessionStore SQLite load', () => {
  it('1000 条消息的会话，loadMessagesPage 只随机读当前页字节', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    for (let i = 0; i < 1000; i++) {
      store.appendMessageFast(session.id, {
        id: `m${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `c${i}`,
        timestamp: i
      })
    }

    const dir = path.join(tmpDir, 'sessions', session.id)
    const jsonlPath = path.join(dir, SESSION_MESSAGES_FILE)
    const fileSize = fs.statSync(jsonlPath).size

    __takeJsonlFullReads()
    __takeJsonlRangeBytesRead()

    const page = store.loadMessagesPage(session.id, { limit: 20 })
    expect(page).not.toBeNull()
    expect(page!.messages).toHaveLength(20)
    expect(page!.messages[0]!.id).toBe('m980')
    expect(page!.messages[19]!.id).toBe('m999')
    expect(page!.hasMore).toBe(true)

    expect(__takeJsonlFullReads()).toBe(0)
    const bytesRead = __takeJsonlRangeBytesRead()
    expect(bytesRead).toBeGreaterThan(0)
    expect(bytesRead).toBeLessThan(fileSize / 5)
  })

  it('append 后立即 loadMessagesPage 能读到新消息', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    store.appendMessageFast(session.id, {
      id: 'a',
      role: 'user',
      content: 'hi',
      timestamp: 1
    })
    store.appendMessageFast(session.id, {
      id: 'b',
      role: 'assistant',
      content: 'yo',
      timestamp: 2
    })

    const page = store.loadMessagesPage(session.id, { limit: 10 })
    expect(page!.messages.map(m => m.id)).toEqual(['a', 'b'])
  })

  it('分叉链的 activePath 正确（只含激活分支）', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    store.appendMessageFast(session.id, {
      id: 'u1',
      role: 'user',
      content: 'q',
      timestamp: 1
    })
    store.appendMessageFast(session.id, {
      id: 'a1',
      role: 'assistant',
      content: 'old',
      timestamp: 2
    })
    store.setCurrentLeaf(session.id, 'u1')
    store.appendMessageFast(session.id, {
      id: 'a2',
      role: 'assistant',
      content: 'new',
      timestamp: 3
    })

    const active = store.loadActivePath(session.id)
    expect(active!.messages.map(m => m.id)).toEqual(['u1', 'a2'])
    expect(active!.messages.some(m => m.id === 'a1')).toBe(false)

    const page = store.loadMessagesPage(session.id, { limit: 10 })
    expect(page!.messages.map(m => m.id)).toEqual(['u1', 'a2'])
  })

  it('关闭索引缓存后 load 自动 rebuild，结果一致', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    for (let i = 0; i < 5; i++) {
      store.appendMessageFast(session.id, {
        id: `x${i}`,
        role: 'user',
        content: `c${i}`,
        timestamp: i
      })
    }
    const dir = path.join(tmpDir, 'sessions', session.id)
    const before = store.loadMessagesPage(session.id, { limit: 5 })
    closeSessionIndex(dir)

    const after = store.loadMessagesPage(session.id, { limit: 5 })
    expect(after!.messages.map(m => m.id)).toEqual(before!.messages.map(m => m.id))
    expect(getSessionIndex(dir).activeCount()).toBe(5)
  })

  it('patch 应用正确：loadMessagesPage 返回的消息含 interrupted', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    store.appendMessageFast(session.id, {
      id: 'asst',
      role: 'assistant',
      content: 'done',
      timestamp: 1
    })
    expect(store.appendMessagePatch(session.id, 'asst', {
      interrupted: true
    })).toBe(true)

    const page = store.loadMessagesPage(session.id, { limit: 5 })
    expect(page!.messages[0]!.interrupted).toBe(true)
  })

  it('computeMessageCount / list 走 SQLite activeCount（不扫全图 jsonl）', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    for (let i = 0; i < 30; i++) {
      store.appendMessageFast(session.id, {
        id: `n${i}`,
        role: 'user',
        content: `c${i}`,
        timestamp: i
      })
    }

    // 清掉 messageCount 迫使 list 重算
    const dir = path.join(tmpDir, 'sessions', session.id)
    const metaPath = path.join(dir, 'session.json')
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    delete meta.messageCount
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8')

    __takeJsonlFullReads()
    __takeJsonlRangeBytesRead()

    const list = store.list()
    const hit = list.find(s => s.id === session.id)
    expect(hit!.messageCount).toBe(30)
    expect(__takeJsonlFullReads()).toBe(0)
    expect(__takeJsonlRangeBytesRead()).toBe(0)
  })

  it('并发 append + load 不出错', async () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')

    const appends: Promise<void>[] = []
    for (let i = 0; i < 20; i++) {
      appends.push(
        Promise.resolve().then(() => {
          store.appendMessageFast(session.id, {
            id: `c${i}`,
            role: 'user',
            content: `x${i}`,
            timestamp: i
          })
        })
      )
    }
    const loads: Promise<void>[] = []
    for (let i = 0; i < 10; i++) {
      loads.push(
        Promise.resolve().then(() => {
          const page = store.loadMessagesPage(session.id, { limit: 5 })
          expect(page).not.toBeNull()
        })
      )
    }
    await Promise.all([...appends, ...loads])
    const final = store.loadMessagesPage(session.id, { limit: 100 })
    expect(final!.messages.length).toBeGreaterThan(0)
  })

  it('1000 条消息的会话，loadForDisplay 不读完整 jsonl，messageCount 为激活路径总数', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    for (let i = 0; i < 1000; i++) {
      store.appendMessageFast(session.id, {
        id: `m${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `c${i}`,
        timestamp: i
      })
    }

    const dir = path.join(tmpDir, 'sessions', session.id)
    const jsonlPath = path.join(dir, SESSION_MESSAGES_FILE)
    const fileSize = fs.statSync(jsonlPath).size

    __takeJsonlFullReads()
    __takeJsonlRangeBytesRead()

    const display = store.loadForDisplay(session.id, { tailLimit: 20 })
    expect(display).not.toBeNull()
    expect(display!.session.messages).toHaveLength(20)
    expect(display!.session.messages[0]!.id).toBe('m980')
    expect(display!.session.messages[19]!.id).toBe('m999')
    expect(display!.session.messageCount).toBe(1000)
    expect(display!.hasMore).toBe(true)
    expect(__takeJsonlFullReads()).toBe(0)
    const bytesRead = __takeJsonlRangeBytesRead()
    expect(bytesRead).toBeGreaterThan(0)
    expect(bytesRead).toBeLessThan(fileSize / 5)
  })

  it('loadForDisplay 在索引不可用时回退全量读仍能打开', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    for (let i = 0; i < 30; i++) {
      store.appendMessageFast(session.id, {
        id: `n${i}`,
        role: 'user',
        content: `c${i}`,
        timestamp: i
      })
    }
    const dir = path.join(tmpDir, 'sessions', session.id)
    closeSessionIndex(dir)
    setSessionIndexOpenFnForTests(() => {
      throw new Error('index unavailable')
    })

    const display = store.loadForDisplay(session.id, { tailLimit: 20 })
    expect(display).not.toBeNull()
    expect(display!.session.messages).toHaveLength(20)
    expect(display!.session.messageCount).toBe(30)
    expect(display!.hasMore).toBe(true)
    expect(display!.session.messages[0]!.id).toBe('n10')
    expect(display!.session.messages[19]!.id).toBe('n29')
  })

  it('子代理任务不在尾页时按索引补读，不写进元数据、不全量读 jsonl', () => {
    const store = new SessionStore(tmpDir)
    const spawnKey = 'task_tool:display-task'
    const child = store.createChildIfAbsent({
      childSessionId: deriveChildSessionId(spawnKey),
      workspaceRoot: '/ws',
      mode: 'default',
      permissionMode: 'request_approval',
      task: 'inspect the runtime',
      subagent: {
        lineage: {
          parentSessionId: 'sess-parent',
          parentRunId: 'run-parent',
          rootRunId: 'run-parent',
          depth: 1,
          spawnKey,
          spawnRunId: '11111111-2222-3333-4444-555555555555',
          origin: {
            kind: 'task_tool',
            parentMessageId: 'msg-parent',
            parentToolCallId: 'call-task'
          }
        },
        profile: {
          profileId: 'explore',
          name: 'explore',
          description: 'read only',
          systemPrompt: 'private prompt',
          toolNames: ['read', 'grep'],
          permissionCeiling: 'read_only',
          maxToolRounds: 20,
          configHash: 'a'.repeat(64)
        }
      },
      codeIndexEnabled: false
    }).session

    for (let i = 0; i < 40; i++) {
      store.appendMessageFast(child.id, {
        id: `later-${i}`,
        role: i % 2 === 0 ? 'assistant' : 'user',
        content: `later-${i}`,
        timestamp: i + 10
      })
    }

    __takeJsonlFullReads()
    const display = store.loadForDisplay(child.id, { tailLimit: 20 })
    expect(display!.hasMore).toBe(true)
    expect(display!.subagentTask).toBe('inspect the runtime')
    expect(display!.session.messages.some(m => m.content === 'inspect the runtime')).toBe(false)
    const metaPath = path.join(tmpDir, 'sessions', child.id, 'session.json')
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { subagentTask?: unknown }
    expect(meta.subagentTask).toBeUndefined()
    expect(__takeJsonlFullReads()).toBe(0)
  })
})
