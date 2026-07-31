import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createLogFn, createProgressFn } from '../../../../../src/runtime/workflow/host/progressFn'
import { runLogPath } from '../../../../../src/runtime/workflow/state/paths'
import { makeHostHarness } from './hostTestContext'

describe('host progressFn', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-host-progress-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('发射带 status 与 detail 的进度事件', () => {
    const h = makeHostHarness(tmp)
    const progress = createProgressFn(h.ctx)

    progress('implement', 'task_complete', { taskId: 't-2', taskName: '加缓存' })

    const event = h.events.find((e) => e.type === 'workflow_progress')
    expect(event).toMatchObject({
      type: 'workflow_progress',
      runId: h.ctx.runId,
      sessionId: 'sess-1',
      phase: 'implement',
      status: 'task_complete',
      detail: { taskId: 't-2', taskName: '加缓存' }
    })
  })

  it('status=started 时同步推进 currentPhase（journal key 依赖它）', () => {
    const h = makeHostHarness(tmp)
    const progress = createProgressFn(h.ctx)

    progress('verify', 'started')
    expect(h.ctx.currentPhase.name).toBe('verify')

    // 非 started 不改变当前阶段
    progress('implement', 'info')
    expect(h.ctx.currentPhase.name).toBe('verify')
  })

  it('scope 关闭后进度与日志静默丢弃', async () => {
    const h = makeHostHarness(tmp)
    const progress = createProgressFn(h.ctx)
    const log = createLogFn(h.ctx)
    await h.scope.close('cancelled')

    expect(() => progress('report', 'started')).not.toThrow()
    expect(() => log('后续日志')).not.toThrow()
    expect(h.events.filter((e) => e.type === 'workflow_progress')).toHaveLength(0)
    expect(h.events.filter((e) => e.type === 'workflow_log')).toHaveLength(0)
    expect(h.ctx.currentPhase.name).toBe('test-phase')
  })

  it('log 同时发事件并落 run 日志文件', () => {
    const h = makeHostHarness(tmp)
    createLogFn(h.ctx)('批次 1 完成')

    expect(h.events.some((e) => e.type === 'workflow_log')).toBe(true)
    expect(readFileSync(runLogPath(tmp, h.ctx.runId), 'utf-8')).toContain('批次 1 完成')
  })
})
