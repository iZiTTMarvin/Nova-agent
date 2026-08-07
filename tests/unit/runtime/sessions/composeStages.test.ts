/**
 * composeStages 持久化：SessionStore 为阶段表唯一写入口。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { SessionStore } from '../../../../src/runtime/sessions/SessionStore'
import { SESSION_DATA_FILE } from '../../../../src/runtime/sessions/types'
import { resetSessionIndexHostForTests } from '../../../../src/runtime/sessions/SessionIndexHost'
import { CURRENT_SESSION_SCHEMA_VERSION } from '../../../../src/runtime/sessions/migrations'

let tmpDir: string

beforeEach(() => {
  resetSessionIndexHostForTests()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-compose-stages-test-'))
})

afterEach(() => {
  resetSessionIndexHostForTests()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('SessionStore composeStages', () => {
  it('applied 后 load 往返一致', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create(path.resolve(tmpDir, 'workspace'), 'compose')

    const result = store.applyComposeStageTransition(session.id, { type: 'complete' })
    expect(result).toMatchObject({ status: 'applied' })
    if (!result || result.status !== 'applied') return

    expect(result.previousStages).toBeNull()
    expect(result.stages[0].status).toBe('completed')
    expect(result.stages[1].status).toBe('in_progress')

    const loaded = store.load(session.id)
    expect(loaded?.composeStages).toEqual(result.stages)
    expect(store.getComposeStages(session.id)).toEqual(result.stages)
  })

  it('rejected 不落盘', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create(path.resolve(tmpDir, 'workspace'), 'compose')
    store.applyComposeStageTransition(session.id, { type: 'complete' })

    const before = store.getComposeStages(session.id)
    const rejected = store.applyComposeStageTransition(session.id, {
      type: 'return',
      targetStage: 'review',
      reason: '越级'
    })
    expect(rejected).toMatchObject({ status: 'rejected' })
    if (!rejected || rejected.status !== 'rejected') return
    expect(rejected.error.length).toBeGreaterThan(0)
    expect(store.getComposeStages(session.id)).toEqual(before)
  })

  it('会话不存在返回 null', () => {
    const store = new SessionStore(tmpDir)
    expect(store.applyComposeStageTransition('sess_nonexistent_00000000-0000-4000-8000-000000000000', { type: 'complete' })).toBeNull()
    expect(store.getComposeStages('sess_nonexistent_00000000-0000-4000-8000-000000000000')).toBeNull()
  })

  it('旧会话无 composeStages：get 返回 null，首次 transition 懒创建并持久化', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create(path.resolve(tmpDir, 'workspace'), 'default')
    const sessionDir = path.join(tmpDir, 'sessions', session.id)
    const metaPath = path.join(sessionDir, SESSION_DATA_FILE)

    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, unknown>
    delete raw.composeStages
    raw.schemaVersion = CURRENT_SESSION_SCHEMA_VERSION
    fs.writeFileSync(metaPath, JSON.stringify(raw, null, 2), 'utf8')

    // 重新构造 store 避免内存缓存干扰（若有）
    const store2 = new SessionStore(tmpDir)
    expect(store2.getComposeStages(session.id)).toBeNull()

    const applied = store2.applyComposeStageTransition(session.id, {
      type: 'skip',
      reason: '旧会话首次推进'
    })
    expect(applied).toMatchObject({ status: 'applied' })
    if (!applied || applied.status !== 'applied') return
    expect(applied.previousStages).toBeNull()
    expect(applied.stages[0]).toMatchObject({
      status: 'skipped',
      note: '旧会话首次推进'
    })
    expect(store2.getComposeStages(session.id)).toEqual(applied.stages)
    expect(store2.load(session.id)?.composeStages).toEqual(applied.stages)
  })
})
