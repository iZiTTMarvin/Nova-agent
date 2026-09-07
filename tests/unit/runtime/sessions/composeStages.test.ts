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
      targetStage: 'inspect',
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

  it('inspect→build 回退计数落盘，重建 store 后仍在', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create(path.resolve(tmpDir, 'workspace'), 'compose')
    for (let i = 0; i < 3; i++) {
      const r = store.applyComposeStageTransition(session.id, { type: 'complete' })
      expect(r).toMatchObject({ status: 'applied' })
      if (!r || r.status !== 'applied') throw new Error('无法推进到验阶段')
    }

    const applied = store.applyComposeStageTransition(session.id, {
      type: 'return',
      targetStage: 'build',
      reason: '核验发现问题'
    })
    expect(applied).toMatchObject({ status: 'applied' })
    if (!applied || applied.status !== 'applied') return
    expect(applied.session.composeReviewLoops).toBe(1)
    expect(store.load(session.id)?.composeReviewLoops).toBe(1)

    const fresh = new SessionStore(tmpDir)
    expect(fresh.load(session.id)?.composeReviewLoops).toBe(1)
  })

  it('第 3 次 inspect→build 回退拒绝，阶段表与计数不被破坏', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create(path.resolve(tmpDir, 'workspace'), 'compose')

    const completeToInspect = (count: number): void => {
      for (let i = 0; i < count; i++) {
        const r = store.applyComposeStageTransition(session.id, { type: 'complete' })
        expect(r).toMatchObject({ status: 'applied' })
        if (!r || r.status !== 'applied') throw new Error('无法推进到验阶段')
      }
    }

    completeToInspect(3)
    for (let i = 0; i < 2; i++) {
      const ret = store.applyComposeStageTransition(session.id, {
        type: 'return',
        targetStage: 'build',
        reason: `返工 ${i + 1}`
      })
      expect(ret).toMatchObject({ status: 'applied' })
      if (!ret || ret.status !== 'applied') throw new Error('从验回退应被放行')
      expect(ret.session.composeReviewLoops).toBe(i + 1)
      // 回到锤修复后再入验：只需 complete 1 次
      completeToInspect(1)
    }

    const before = store.getComposeStages(session.id)
    const third = store.applyComposeStageTransition(session.id, {
      type: 'return',
      targetStage: 'build',
      reason: '第 3 次回退'
    })
    expect(third).toMatchObject({ status: 'rejected' })
    if (!third || third.status !== 'rejected') return
    expect(third.error).toMatch(/上限/)
    expect(store.getComposeStages(session.id)).toEqual(before)
    expect(store.load(session.id)?.composeReviewLoops).toBe(2)
  })
})
