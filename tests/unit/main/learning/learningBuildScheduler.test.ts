import { describe, expect, it } from 'vitest'
import {
  LearningBuildScheduler,
  type LearningBuildAttemptResult
} from '../../../../src/main/learning/LearningBuildScheduler'
import type { ModelClient } from '../../../../src/runtime/model/ModelClient'
import type { LearningBuildStage } from '../../../../src/shared/learning/surface'

interface Attempt {
  readonly workspaceRoot: string
  readonly signal: AbortSignal
  readonly onStage: (stage: LearningBuildStage) => void
  resolve(result: LearningBuildAttemptResult): void
}

const model = {} as ModelClient

function setup(options: { busy?: boolean } = {}) {
  let busy = options.busy ?? false
  const foreground = new Set<() => void>()
  const workspace = new Set<(change: { previousRoot: string | null; nextRoot: string | null }) => void>()
  const attempts: Attempt[] = []
  const scheduler = new LearningBuildScheduler({
    isForegroundBusy: () => busy,
    subscribeForeground: listener => { foreground.add(listener); return () => foreground.delete(listener) },
    subscribeWorkspaceChanges: listener => { workspace.add(listener); return () => workspace.delete(listener) },
    runBuild: (workspaceRoot, _model, signal, onStage) => new Promise(resolve => {
      attempts.push({ workspaceRoot, signal, onStage, resolve })
    }),
    onChanged: () => undefined
  })
  const setBusy = (next: boolean) => { busy = next; foreground.forEach(listener => listener()) }
  const switchWorkspace = (previousRoot: string, nextRoot: string) =>
    workspace.forEach(listener => listener({ previousRoot, nextRoot }))
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  return { scheduler, attempts, setBusy, switchWorkspace, settle }
}

describe('大纲生成调度', () => {
  it('没有模型直接失败，不开始尝试', () => {
    const { scheduler, attempts } = setup()
    scheduler.request('/a', null)
    expect(scheduler.getState('/a')).toEqual({ status: 'failed', reason: 'no_model' })
    expect(attempts).toHaveLength(0)
  })

  it('前台空闲时立即运行，阶段回调更新状态，成功后回到 idle', async () => {
    const { scheduler, attempts, settle } = setup()
    scheduler.request('/a', model)
    expect(scheduler.getState('/a')).toEqual({ status: 'running', stage: 'collecting' })
    attempts[0]!.onStage('analyzing')
    expect(scheduler.getState('/a')).toEqual({ status: 'running', stage: 'analyzing' })
    attempts[0]!.resolve({ ok: true })
    await settle()
    expect(scheduler.getState('/a')).toEqual({ status: 'idle' })
  })

  it('前台忙时排队，前台空闲后开始', () => {
    const { scheduler, attempts, setBusy } = setup({ busy: true })
    scheduler.request('/a', model)
    expect(scheduler.getState('/a')).toEqual({ status: 'queued' })
    expect(attempts).toHaveLength(0)
    setBusy(false)
    expect(scheduler.getState('/a')).toEqual({ status: 'running', stage: 'collecting' })
    expect(attempts).toHaveLength(1)
  })

  it('运行中前台开始任务 → 暂停并自动续接一次；第二次暂停不再自动续接，用户继续后仍可运行', async () => {
    const { scheduler, attempts, setBusy, settle } = setup()
    scheduler.request('/a', model)
    setBusy(true)
    expect(attempts[0]!.signal.aborted).toBe(true)
    expect(scheduler.getState('/a')).toEqual({ status: 'paused', autoResume: true })
    setBusy(false)
    expect(scheduler.getState('/a')).toEqual({ status: 'running', stage: 'collecting' })
    expect(attempts).toHaveLength(2)

    // 被中止的旧尝试迟到的阶段与结果都被丢弃
    attempts[0]!.onStage('validating')
    attempts[0]!.resolve({ ok: false, code: 'provider_error', reason: 'late' })
    await settle()
    expect(scheduler.getState('/a')).toEqual({ status: 'running', stage: 'collecting' })

    setBusy(true)
    expect(scheduler.getState('/a')).toEqual({ status: 'paused', autoResume: false })
    setBusy(false)
    expect(scheduler.getState('/a')).toEqual({ status: 'paused', autoResume: false })
    expect(attempts).toHaveLength(2)

    setBusy(true)
    scheduler.request('/a', model)
    expect(scheduler.getState('/a')).toEqual({ status: 'queued' })
    setBusy(false)
    expect(attempts).toHaveLength(3)
    attempts[2]!.resolve({ ok: true })
    await settle()
    expect(scheduler.getState('/a')).toEqual({ status: 'idle' })
  })

  it('用户取消：排队、运行、暂停都回到 idle，运行中的尝试被中止', () => {
    const queued = setup({ busy: true })
    queued.scheduler.request('/a', model)
    queued.scheduler.cancel('/a')
    expect(queued.scheduler.getState('/a')).toEqual({ status: 'idle' })
    queued.setBusy(false)
    expect(queued.attempts).toHaveLength(0)

    const running = setup()
    running.scheduler.request('/a', model)
    running.scheduler.cancel('/a')
    expect(running.attempts[0]!.signal.aborted).toBe(true)
    expect(running.scheduler.getState('/a')).toEqual({ status: 'idle' })

    const paused = setup()
    paused.scheduler.request('/a', model)
    paused.setBusy(true)
    paused.scheduler.cancel('/a')
    paused.setBusy(false)
    expect(paused.scheduler.getState('/a')).toEqual({ status: 'idle' })
    expect(paused.attempts).toHaveLength(1)
  })

  it('构建失败按结构化原因分类；provider 详情截断', async () => {
    const { scheduler, attempts, settle } = setup()
    scheduler.request('/a', model)
    attempts[0]!.resolve({ ok: false, code: 'provider_error', reason: 'x'.repeat(200) })
    await settle()
    const state = scheduler.getState('/a')
    expect(state.status === 'failed' && state.reason).toBe('provider_error')
    expect(state.status === 'failed' && state.detail?.length).toBe(80)

    scheduler.request('/a', model)
    attempts[1]!.resolve({ ok: false, code: 'context_too_small', reason: 'budget' })
    await settle()
    expect(scheduler.getState('/a')).toEqual({ status: 'failed', reason: 'context_too_small' })
  })

  it('单飞：另一个项目正在生成时拒绝，原项目不受影响', () => {
    const { scheduler, attempts } = setup()
    scheduler.request('/a', model)
    scheduler.request('/b', model)
    expect(scheduler.getState('/b')).toEqual({ status: 'failed', reason: 'busy_other_project' })
    expect(scheduler.getState('/a')).toEqual({ status: 'running', stage: 'collecting' })
    expect(attempts).toHaveLength(1)
  })

  it('工作区切走时中止并回到 idle', () => {
    const { scheduler, attempts, switchWorkspace } = setup()
    scheduler.request('/a', model)
    switchWorkspace('/a', '/b')
    expect(attempts[0]!.signal.aborted).toBe(true)
    expect(scheduler.getState('/a')).toEqual({ status: 'idle' })
  })
})
