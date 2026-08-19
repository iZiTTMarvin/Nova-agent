/**
 * 工具组激活态的会话级持久化：写入 / 重启恢复 / 压缩与分支无关性 / 旧数据兼容。
 * 激活态位于 session.json 元数据，独立于消息历史——上下文压缩裁剪消息不得丢失能力激活。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  SessionStore
} from '../../../../src/runtime/sessions/SessionStore'
import { SESSION_DATA_FILE, SESSION_MESSAGES_FILE } from '../../../../src/runtime/sessions/types'
import type { SessionMessage } from '../../../../src/runtime/sessions/types'
import { CURRENT_SESSION_SCHEMA_VERSION } from '../../../../src/runtime/sessions/migrations'
import {
  LOAD_TOOLS_ACTIVATED_MARKER,
  ToolAvailability
} from '../../../../src/runtime/tools/availability'
import { resetSessionIndexHostForTests } from '../../../../src/runtime/sessions/SessionIndexHost'

let tmpDir: string

beforeEach(() => {
  resetSessionIndexHostForTests()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-tool-availability-test-'))
})

afterEach(() => {
  resetSessionIndexHostForTests()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function sessionDir(sessionId: string): string {
  return path.join(tmpDir, 'sessions', sessionId)
}

const REGISTERED = ['read', 'task', 'load_tools']

function createAvailability(): ToolAvailability {
  const availability = new ToolAvailability()
  availability.setEconomyMode('on')
  availability.bindRegisteredToolNames(REGISTERED)
  return availability
}

function toolMessage(id: string, content: string): SessionMessage {
  return {
    id,
    parentId: null,
    role: 'tool',
    content,
    toolCallId: `call-${id}`,
    timestamp: Date.now()
  }
}

describe('工具组激活态持久化', () => {
  it('激活态写入 session.json 并在重启（新 Store 实例）后恢复', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    store.updateToolAvailability(session.id, { version: 1, activatedGroups: ['agent'] })

    const restarted = new SessionStore(tmpDir)
    const loaded = restarted.load(session.id)
    expect(loaded?.toolAvailability).toEqual({ version: 1, activatedGroups: ['agent'] })

    const availability = createAvailability()
    availability.restoreFromSessionState(loaded?.toolAvailability)
    expect(availability.isToolAvailable('task')).toBe(true)
  })

  it('null 清除激活态字段', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    store.updateToolAvailability(session.id, { version: 1, activatedGroups: ['agent'] })
    store.updateToolAvailability(session.id, null)
    expect(new SessionStore(tmpDir).load(session.id)?.toolAvailability).toBeUndefined()
  })

  it('激活态独立于消息历史：清空 messages.jsonl（模拟压缩裁剪）后仍恢复', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    store.updateToolAvailability(session.id, { version: 1, activatedGroups: ['agent'] })

    const messagesPath = path.join(sessionDir(session.id), SESSION_MESSAGES_FILE)
    fs.writeFileSync(messagesPath, '', 'utf8')

    const loaded = new SessionStore(tmpDir).load(session.id)
    expect(loaded?.toolAvailability).toEqual({ version: 1, activatedGroups: ['agent'] })
  })

  it('会话分支切换（setCurrentLeaf）不改变激活态', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    const branch = { ...toolMessage('m1', 'branch'), parentId: session.currentLeafId }
    store.appendMessage(session.id, branch)
    store.updateToolAvailability(session.id, { version: 1, activatedGroups: ['agent'] })

    store.setCurrentLeaf(session.id, branch.id)

    const loaded = new SessionStore(tmpDir).load(session.id)
    expect(loaded?.toolAvailability).toEqual({ version: 1, activatedGroups: ['agent'] })
  })

  it('持久化中的未知组 / alias 在恢复时归一化并忽略未知项', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    store.updateToolAvailability(session.id, {
      version: 1,
      activatedGroups: ['orchestration', 'ghost', 'browser']
    })

    const availability = createAvailability()
    const { restoredGroups } = availability.restoreFromSessionState(
      new SessionStore(tmpDir).load(session.id)?.toolAvailability
    )
    // orchestration → agent；ghost / 预留 browser 安全忽略
    expect(restoredGroups).toEqual(['agent'])
  })

  it('磁盘上的损坏字段不阻断会话加载，恢复入口按不可用处理', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    const dataPath = path.join(sessionDir(session.id), SESSION_DATA_FILE)
    const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8')) as Record<string, unknown>
    raw.toolAvailability = { version: 1, activatedGroups: 'not-an-array' }
    fs.writeFileSync(dataPath, JSON.stringify(raw, null, 2), 'utf8')

    const loaded = new SessionStore(tmpDir).load(session.id)
    expect(loaded).not.toBeNull()
    const availability = createAvailability()
    const restored = availability.restoreFromSessionState(loaded?.toolAvailability)
    expect(restored.usable).toBe(false)
    expect(restored.restoredGroups).toEqual([])
    // 视同缺失：损坏不占用 durable 态，消息 marker 回填可接管
    expect(availability.backfillFromMessages([]).restoredGroups).toEqual([])
  })
})

describe('旧消息 marker 回填（兼容路径）', () => {
  it('旧会话无持久化字段：扫描历史 marker 恢复（含 alias 归一），并回填落盘', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')

    const loadCall: SessionMessage = {
      id: 'm0',
      parentId: null,
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 'call-a',
          name: 'load_tools',
          arguments: JSON.stringify({ group: 'orchestration' })
        }
      ],
      timestamp: Date.now()
    }
    store.appendMessage(session.id, loadCall)
    store.appendMessage(
      session.id,
      toolMessage('a', `Activated\n${LOAD_TOOLS_ACTIVATED_MARKER}orchestration`)
    )

    const availability = createAvailability()
    const { restoredGroups } = availability.backfillFromMessages(
      store.load(session.id)?.messages ?? []
    )
    expect(restoredGroups).toEqual(['agent'])

    // 回填结果落盘后，重启直接从持久态恢复，不再依赖消息
    store.updateToolAvailability(session.id, {
      version: 1,
      activatedGroups: [...restoredGroups]
    })
    const next = createAvailability()
    next.restoreFromSessionState(new SessionStore(tmpDir).load(session.id)?.toolAvailability)
    expect(next.isToolAvailable('task')).toBe(true)
  })
})

describe('schema 迁移兼容', () => {
  it('v14 旧会话（无 toolAvailability 字段）迁移到当前版本后可正常读取', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create('/ws')
    const dataPath = path.join(sessionDir(session.id), SESSION_DATA_FILE)
    const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8')) as Record<string, unknown>
    delete raw.toolAvailability
    raw.schemaVersion = 14
    fs.writeFileSync(dataPath, JSON.stringify(raw, null, 2), 'utf8')

    const loaded = new SessionStore(tmpDir).load(session.id)
    expect(loaded?.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION)
    expect(loaded?.toolAvailability).toBeUndefined()
  })
})
