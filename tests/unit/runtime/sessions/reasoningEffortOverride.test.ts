/**
 * 会话思考强度覆盖的持久化与迁移：
 * - SessionStore.updateReasoningEffortOverride 写入 / 清除并落盘
 * - v10 旧会话迁移到 v11 后无覆盖字段（语义为无覆盖）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { SessionStore } from '../../../../src/runtime/sessions/SessionStore'
import {
  CURRENT_SESSION_SCHEMA_VERSION,
  migrateSessionData
} from '../../../../src/runtime/sessions/migrations'
import { resetSessionIndexHostForTests } from '../../../../src/runtime/sessions/SessionIndexHost'

let tmpDir: string

beforeEach(() => {
  resetSessionIndexHostForTests()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-effort-override-test-'))
})

afterEach(() => {
  resetSessionIndexHostForTests()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('SessionStore 思考强度覆盖', () => {
  it('写入后 load 可恢复，且只改元数据', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create(path.resolve(tmpDir, 'workspace'), 'default')

    const updated = store.updateReasoningEffortOverride(session.id, 'max')
    expect(updated?.reasoningEffortOverride).toBe('max')
    expect(store.load(session.id)?.reasoningEffortOverride).toBe('max')
  })

  it('null 清除覆盖，字段不再出现在持久化数据中', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create(path.resolve(tmpDir, 'workspace'), 'default')

    store.updateReasoningEffortOverride(session.id, 'low')
    const cleared = store.updateReasoningEffortOverride(session.id, null)
    expect(cleared?.reasoningEffortOverride).toBeUndefined()
    expect(store.load(session.id)?.reasoningEffortOverride).toBeUndefined()
  })

  it('会话不存在时返回 null，不抛错', () => {
    const store = new SessionStore(tmpDir)
    expect(store.updateReasoningEffortOverride('nope', 'high')).toBeNull()
  })
})

describe('schema v10 → v11 迁移', () => {
  it('当前版本包含会话权限模式字段', () => {
    expect(CURRENT_SESSION_SCHEMA_VERSION).toBe(17)
  })

  it('v10 会话迁移后无覆盖字段，结构合法', () => {
    const v10 = {
      schemaVersion: 10,
      kind: 'primary',
      id: 'sess-v10',
      workspaceRoot: '/tmp/ws',
      mode: 'default',
      messages: [],
      currentLeafId: null,
      createdAt: 1,
      updatedAt: 1
    }

    const migrated = migrateSessionData(v10)
    expect(migrated.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION)
    expect(migrated.reasoningEffortOverride).toBeUndefined()
    expect(migrated.kind).toBe('primary')
  })
})
