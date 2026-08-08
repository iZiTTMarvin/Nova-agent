/**
 * composePlanApproval 持久化：SessionStore 为计划确认门状态唯一写入口。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { SessionStore } from '../../../../src/runtime/sessions/SessionStore'
import { resetSessionIndexHostForTests } from '../../../../src/runtime/sessions/SessionIndexHost'

let tmpDir: string

beforeEach(() => {
  resetSessionIndexHostForTests()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-plan-approval-test-'))
})

afterEach(() => {
  resetSessionIndexHostForTests()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('SessionStore composePlanApproval', () => {
  it('新会话默认视为 pending（无需先写入即可读取默认值）', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create(path.resolve(tmpDir, 'workspace'), 'compose')

    expect(store.getComposePlanApproval(session.id)).toEqual({ status: 'pending' })
    expect(store.load(session.id)?.composePlanApproval).toBeUndefined()
  })

  it('会话不存在返回 null', () => {
    const store = new SessionStore(tmpDir)
    const missingId = 'sess_nonexistent_00000000-0000-4000-8000-000000000000'
    expect(store.getComposePlanApproval(missingId)).toBeNull()
    expect(store.approveComposePlan(missingId, { auto: false })).toBeNull()
    expect(store.resetComposePlanApproval(missingId)).toBeNull()
  })

  it('approveComposePlan 手动批准落盘，往返一致', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create(path.resolve(tmpDir, 'workspace'), 'compose')

    const approval = store.approveComposePlan(session.id, { auto: false })
    expect(approval).toMatchObject({ status: 'approved', auto: false })
    expect(approval?.approvedAt).toBeGreaterThan(0)

    expect(store.getComposePlanApproval(session.id)).toEqual(approval)
    expect(store.load(session.id)?.composePlanApproval).toEqual(approval)
  })

  it('approveComposePlan 携带 auto: true 时留痕为自动批准', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create(path.resolve(tmpDir, 'workspace'), 'compose')

    const approval = store.approveComposePlan(session.id, { auto: true })
    expect(approval).toMatchObject({ status: 'approved', auto: true })
  })

  it('resetComposePlanApproval 把已批准状态清回 pending', () => {
    const store = new SessionStore(tmpDir)
    const session = store.create(path.resolve(tmpDir, 'workspace'), 'compose')
    store.approveComposePlan(session.id, { auto: false })

    const session2 = store.resetComposePlanApproval(session.id)
    expect(session2?.composePlanApproval).toEqual({ status: 'pending' })
    expect(store.getComposePlanApproval(session.id)).toEqual({ status: 'pending' })

    const fresh = new SessionStore(tmpDir)
    expect(fresh.getComposePlanApproval(session.id)).toEqual({ status: 'pending' })
  })
})
