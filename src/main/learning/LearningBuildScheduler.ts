/**
 * 大纲生成调度器：大纲生成状态的唯一写入者。
 * 全应用同时最多一个生成需求；前台任务运行时让路（排队或暂停），前台空闲后自动续接一次。
 * 每次尝试带 generation，被中止的尝试迟到的阶段回调与结果一律丢弃。
 */
import type { ModelClient } from '../../runtime/model/ModelClient'
import type { SkeletonBuildFailureCode } from '../../runtime/learning/build/SkeletonKnowledgeBuild'
import type {
  LearningBuildFailureReason,
  LearningBuildStage,
  LearningBuildState
} from '../../shared/learning/surface'

/** 一次尝试的结果；abort 时 runBuild 应抛出（或返回任意值，都会被 generation 丢弃）。 */
export type LearningBuildAttemptResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: SkeletonBuildFailureCode; readonly reason: string }

export interface LearningBuildSchedulerDeps {
  readonly isForegroundBusy: () => boolean
  readonly subscribeForeground: (listener: () => void) => () => void
  readonly subscribeWorkspaceChanges: (
    listener: (change: { previousRoot: string | null; nextRoot: string | null }) => void
  ) => () => void
  readonly runBuild: (
    workspaceRoot: string,
    model: ModelClient,
    signal: AbortSignal,
    onStage: (stage: LearningBuildStage) => void
  ) => Promise<LearningBuildAttemptResult>
  readonly onChanged: (workspaceRoot: string) => void
}

/** 同一个生成需求内允许的自动续接次数。 */
const MAX_AUTO_RESUMES = 1
const PROVIDER_DETAIL_MAX_CHARS = 80

interface BuildJob {
  readonly workspaceRoot: string
  readonly model: ModelClient
  resumeCount: number
  attempt: { readonly generation: number; readonly controller: AbortController } | null
}

export class LearningBuildScheduler {
  private readonly states = new Map<string, LearningBuildState>()
  private job: BuildJob | null = null
  private generation = 0
  private readonly unsubscribers: Array<() => void>

  constructor(private readonly deps: LearningBuildSchedulerDeps) {
    this.unsubscribers = [
      deps.subscribeForeground(() => this.onForegroundChanged()),
      deps.subscribeWorkspaceChanges(change => {
        const job = this.job
        if (job && change.previousRoot === job.workspaceRoot && change.nextRoot !== job.workspaceRoot) {
          this.clearJob('idle')
        }
      })
    ]
  }

  getState(workspaceRoot: string): LearningBuildState {
    return this.states.get(workspaceRoot) ?? { status: 'idle' }
  }

  /** 用户请求生成或「继续」；已在排队/运行/自动续接中的同项目需求不重复开启。 */
  request(workspaceRoot: string, model: ModelClient | null): void {
    if (!model) {
      this.setState(workspaceRoot, { status: 'failed', reason: 'no_model' })
      return
    }
    const job = this.job
    if (job && job.workspaceRoot !== workspaceRoot) {
      this.setState(workspaceRoot, { status: 'failed', reason: 'busy_other_project' })
      return
    }
    if (job) {
      const state = this.getState(workspaceRoot)
      // 只有「暂停且不再自动继续」接受用户继续；续接次数不清零
      if (state.status !== 'paused' || state.autoResume) return
      this.admit(job)
      return
    }
    const created: BuildJob = { workspaceRoot, model, resumeCount: 0, attempt: null }
    this.job = created
    this.admit(created)
  }

  cancel(workspaceRoot: string): void {
    if (this.job?.workspaceRoot === workspaceRoot) this.clearJob('idle')
  }

  dispose(): void {
    if (this.job) this.clearJob('idle')
    for (const unsubscribe of this.unsubscribers) unsubscribe()
    this.states.clear()
  }

  private admit(job: BuildJob): void {
    if (this.deps.isForegroundBusy()) {
      this.setState(job.workspaceRoot, { status: 'queued' })
      return
    }
    this.start(job)
  }

  private start(job: BuildJob): void {
    const generation = ++this.generation
    const controller = new AbortController()
    job.attempt = { generation, controller }
    this.setState(job.workspaceRoot, { status: 'running', stage: 'collecting' })
    const isCurrent = () => this.job === job && job.attempt?.generation === generation
    void this.deps
      .runBuild(job.workspaceRoot, job.model, controller.signal, stage => {
        if (isCurrent()) this.setState(job.workspaceRoot, { status: 'running', stage })
      })
      .then(
        result => {
          if (!isCurrent()) return
          this.job = null
          this.setState(job.workspaceRoot, result.ok ? { status: 'idle' } : failedState(result.code, result.reason))
        },
        error => {
          if (!isCurrent()) return
          this.job = null
          this.setState(job.workspaceRoot, failedState('storage_unavailable', error instanceof Error ? error.message : String(error)))
        }
      )
  }

  private onForegroundChanged(): void {
    const job = this.job
    if (!job) return
    const busy = this.deps.isForegroundBusy()
    const state = this.getState(job.workspaceRoot)
    if (busy && state.status === 'running') {
      this.abortAttempt(job)
      this.setState(job.workspaceRoot, { status: 'paused', autoResume: job.resumeCount < MAX_AUTO_RESUMES })
      return
    }
    if (busy) return
    if (state.status === 'queued') {
      this.start(job)
    } else if (state.status === 'paused' && state.autoResume) {
      job.resumeCount++
      this.start(job)
    }
  }

  private abortAttempt(job: BuildJob): void {
    job.attempt?.controller.abort()
    job.attempt = null
  }

  private clearJob(next: 'idle'): void {
    const job = this.job
    if (!job) return
    this.abortAttempt(job)
    this.job = null
    this.setState(job.workspaceRoot, { status: next })
  }

  private setState(workspaceRoot: string, state: LearningBuildState): void {
    this.states.set(workspaceRoot, state)
    this.deps.onChanged(workspaceRoot)
  }
}

function failedState(code: SkeletonBuildFailureCode, reason: string): LearningBuildState {
  const mapped: LearningBuildFailureReason = code
  return mapped === 'provider_error'
    ? { status: 'failed', reason: mapped, detail: reason.slice(0, PROVIDER_DETAIL_MAX_CHARS) }
    : { status: 'failed', reason: mapped }
}
