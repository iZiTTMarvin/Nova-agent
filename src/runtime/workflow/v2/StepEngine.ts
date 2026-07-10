/**
 * Workflow v2 StepEngine：可恢复 DAG 执行器。
 * step 状态 pending→running→committed|failed；已 committed 不重复执行。
 */
import type { TaskScope } from '../TaskScope'
import {
  appendV2Event,
  computeInputHash,
  listStepRecords,
  makeIdempotencyKey,
  readManifest,
  readStepRecord,
  writeManifest,
  writeStepRecord
} from './stepStore'
import type {
  ResumePlan,
  StepDefinition,
  StepKind,
  StepPolicy,
  StepRecord,
  StepRunContext,
  WorkflowV2Manifest
} from './types'

function nowIso(): string {
  return new Date().toISOString()
}

export interface StepEngineOptions {
  workspaceRoot: string
  runId: string
  workflowName: string
  scriptSha: string
  scope: TaskScope
  /** 从该 step 起强制重跑（含该 step） */
  rerunFromStepId?: string
  /** 脚本源不匹配时：reject | migrate */
  onScriptShaMismatch?: 'reject' | 'migrate'
}

export class StepEngine {
  private readonly workspaceRoot: string
  private readonly runId: string
  private readonly workflowName: string
  private readonly scriptSha: string
  private readonly scope: TaskScope
  private readonly scopeGen: number
  private readonly rerunFromStepId?: string
  private readonly defs = new Map<string, StepDefinition>()
  private readonly order: string[] = []
  private readonly outputs = new Map<string, unknown>()
  private manifest: WorkflowV2Manifest

  constructor(opts: StepEngineOptions) {
    this.workspaceRoot = opts.workspaceRoot
    this.runId = opts.runId
    this.workflowName = opts.workflowName
    this.scriptSha = opts.scriptSha
    this.scope = opts.scope
    this.scopeGen = opts.scope.captureGeneration()
    this.rerunFromStepId = opts.rerunFromStepId

    const existing = readManifest(opts.workspaceRoot, opts.runId)
    if (existing) {
      if (existing.scriptSha !== opts.scriptSha) {
        const policy = opts.onScriptShaMismatch ?? 'reject'
        if (policy === 'reject') {
          throw new Error(
            `workflow v2 script source changed for run ${opts.runId}; ` +
              `refuse silent resume (pass scriptShaMismatch:'migrate' to clear steps).`
          )
        }
        // migrate：保留目录但重置 manifest / 不复用旧 step
        this.manifest = this.createFreshManifest()
      } else {
        this.manifest = {
          ...existing,
          updatedAt: nowIso(),
          status: 'running',
          rerunFromStepId: opts.rerunFromStepId ?? existing.rerunFromStepId
        }
        // 预载已 committed 输出
        for (const rec of listStepRecords(opts.workspaceRoot, opts.runId)) {
          if (rec.status === 'committed') {
            this.outputs.set(rec.stepId, rec.output)
          }
        }
      }
    } else {
      this.manifest = this.createFreshManifest()
    }
    writeManifest(this.workspaceRoot, this.manifest)
  }

  private createFreshManifest(): WorkflowV2Manifest {
    return {
      version: 2,
      workflowName: this.workflowName,
      scriptSha: this.scriptSha,
      runId: this.runId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: 'running',
      stepIds: [],
      rerunFromStepId: this.rerunFromStepId
    }
  }

  /** 注册 step（可在运行中动态追加，如 plan 产出后的 execute 任务） */
  register(def: StepDefinition): void {
    if (this.defs.has(def.id)) {
      // 同 id 允许覆盖 run 函数（动态图），但 input 变化会走新 hash
      this.defs.set(def.id, def)
      return
    }
    this.defs.set(def.id, def)
    this.order.push(def.id)
    this.manifest.stepIds = [...this.order]
    this.manifest.updatedAt = nowIso()
    writeManifest(this.workspaceRoot, this.manifest)

    // 若磁盘无记录，写 pending
    const existing = readStepRecord(this.workspaceRoot, this.runId, def.id)
    if (!existing) {
      const inputHash = computeInputHash(def.input)
      const rec: StepRecord = {
        stepId: def.id,
        kind: def.kind,
        inputHash,
        idempotencyKey: makeIdempotencyKey(this.runId, def.id, inputHash),
        status: 'pending',
        policy: def.policy ?? { retryable: true },
        deps: def.deps
      }
      writeStepRecord(this.workspaceRoot, this.runId, rec)
    }
  }

  getOutput<T = unknown>(stepId: string): T | undefined {
    return this.outputs.get(stepId) as T | undefined
  }

  /** 预览 resume 计划（UI「查看将跳过」） */
  planResume(): ResumePlan {
    const skip: ResumePlan['skip'] = []
    const run: ResumePlan['run'] = []
    const blocked: ResumePlan['blocked'] = []
    const forceFrom = this.manifest.rerunFromStepId
    let force = false

    for (const id of this.order) {
      if (forceFrom && id === forceFrom) force = true
      const def = this.defs.get(id)
      if (!def) continue
      const inputHash = computeInputHash(def.input)
      const rec = readStepRecord(this.workspaceRoot, this.runId, id)
      const kind = def.kind

      if (force) {
        run.push({ stepId: id, kind, status: rec?.status ?? 'pending' })
        continue
      }
      if (rec?.status === 'committed' && rec.inputHash === inputHash) {
        skip.push({ stepId: id, kind, status: 'committed' })
        continue
      }
      if (rec?.status === 'failed' && !(rec.policy.retryable ?? true)) {
        blocked.push({ stepId: id, kind, error: rec.error })
        continue
      }
      run.push({ stepId: id, kind, status: rec?.status ?? 'pending' })
    }
    return { skip, run, blocked }
  }

  /**
   * 按依赖拓扑分层执行（同层可并行）；已 committed 且 inputHash 未变则跳过。
   * 上游失败时下游标 blocked，不得跨层抢跑。
   * finalize=false 时不把 run 标为 completed（分阶段注册动态 step 时用）。
   */
  async runAll(opts?: {
    finalize?: boolean
  }): Promise<{ status: 'completed' | 'failed' | 'cancelled'; error?: string }> {
    let layers: string[][]
    try {
      layers = this.computeTopoLayers()
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.setRunStatus('failed')
      return { status: 'failed', error }
    }

    const forceFrom = this.manifest.rerunFromStepId
    const forceIds = new Set<string>()
    if (forceFrom) {
      let hit = false
      for (const layer of layers) {
        for (const id of layer) {
          if (id === forceFrom) hit = true
          if (hit) forceIds.add(id)
        }
      }
    }

    /** 已失败/阻断的 step，下游不得执行 */
    const blocked = new Set<string>()

    for (const layer of layers) {
      if (this.scope.isClosed || !this.scope.isCurrent(this.scopeGen)) {
        this.setRunStatus('cancelled')
        return { status: 'cancelled' }
      }

      const runnable = layer.filter((id) => {
        const def = this.defs.get(id)
        if (!def) return false
        const deps = def.deps ?? []
        if (deps.some((d) => blocked.has(d))) {
          blocked.add(id)
          return false
        }
        return true
      })

      // 同层并行；任一步失败则记录 blocked，本层结束后再决定是否整体失败
      const results = await Promise.allSettled(
        runnable.map(async (id) => {
          const def = this.defs.get(id)!
          const force = forceIds.has(id)
          await this.runOne(def, force)
        })
      )

      let layerError: string | undefined
      for (let i = 0; i < results.length; i++) {
        const r = results[i]
        const id = runnable[i]
        if (r.status === 'rejected') {
          blocked.add(id)
          if (this.scope.signal.aborted || this.scope.isClosed) {
            this.setRunStatus('cancelled')
            return { status: 'cancelled' }
          }
          layerError = r.reason instanceof Error ? r.reason.message : String(r.reason)
        }
      }
      if (layerError) {
        this.setRunStatus('failed')
        return { status: 'failed', error: layerError }
      }
    }

    if (opts?.finalize !== false) {
      this.setRunStatus('completed')
    } else {
      this.manifest.updatedAt = nowIso()
      writeManifest(this.workspaceRoot, this.manifest)
    }
    return { status: 'completed' }
  }

  /**
   * Kahn 拓扑分层：校验依赖存在、检测环，生成稳定并行层。
   * 同层内按注册顺序排序，保证确定性。
   */
  private computeTopoLayers(): string[][] {
    const ids = [...this.order]
    const idSet = new Set(ids)
    const indeg = new Map<string, number>()
    const children = new Map<string, string[]>()

    for (const id of ids) {
      indeg.set(id, 0)
      children.set(id, [])
    }

    for (const id of ids) {
      const def = this.defs.get(id)
      const deps = def?.deps ?? []
      for (const d of deps) {
        if (!idSet.has(d)) {
          throw new Error(`step ${id} 依赖不存在: ${d}`)
        }
        indeg.set(id, (indeg.get(id) ?? 0) + 1)
        children.get(d)!.push(id)
      }
    }

    const layers: string[][] = []
    let ready = ids.filter((id) => (indeg.get(id) ?? 0) === 0)
    // 稳定：同层按注册顺序
    ready.sort((a, b) => this.order.indexOf(a) - this.order.indexOf(b))

    let visited = 0
    while (ready.length > 0) {
      layers.push([...ready])
      visited += ready.length
      const next: string[] = []
      for (const id of ready) {
        for (const child of children.get(id) ?? []) {
          const n = (indeg.get(child) ?? 0) - 1
          indeg.set(child, n)
          if (n === 0) next.push(child)
        }
      }
      next.sort((a, b) => this.order.indexOf(a) - this.order.indexOf(b))
      ready = next
    }

    if (visited !== ids.length) {
      const leftover = ids.filter((id) => (indeg.get(id) ?? 0) > 0)
      throw new Error(`step 依赖成环: ${leftover.join(', ')}`)
    }
    return layers
  }

  private async runOne(def: StepDefinition, force: boolean): Promise<unknown> {
    const inputHash = computeInputHash(def.input)
    const idempotencyKey = makeIdempotencyKey(this.runId, def.id, inputHash)
    const existing = readStepRecord(this.workspaceRoot, this.runId, def.id)

    // 已 committed 且 hash 匹配：跳过（除非 force rerun）
    if (
      !force &&
      existing?.status === 'committed' &&
      existing.inputHash === inputHash
    ) {
      this.outputs.set(def.id, existing.output)
      return existing.output
    }

    // 非 retryable 失败且未 force：阻断
    if (
      !force &&
      existing?.status === 'failed' &&
      !(existing.policy.retryable ?? true)
    ) {
      throw new Error(existing.error ?? `step ${def.id} failed permanently`)
    }

    const policy: StepPolicy = def.policy ?? { retryable: true }
    const at = nowIso()
    const running: StepRecord = {
      stepId: def.id,
      kind: def.kind,
      inputHash,
      idempotencyKey,
      status: 'running',
      policy,
      deps: def.deps,
      startedAt: at
    }
    writeStepRecord(this.workspaceRoot, this.runId, running)
    appendV2Event(this.workspaceRoot, this.runId, {
      t: 'step_started',
      stepId: def.id,
      inputHash,
      at
    })

    const ctx: StepRunContext = {
      runId: this.runId,
      stepId: def.id,
      inputHash,
      idempotencyKey,
      signal: this.scope.signal,
      getOutput: <T>(sid: string) => this.getOutput<T>(sid)
    }

    try {
      if (!this.scope.isCurrent(this.scopeGen)) {
        throw new Error('TaskScope closed before step run')
      }
      const output = await this.scope.spawn(() => def.run(ctx), {
        label: `step:${def.id}`
      })

      // 提交前再校验 generation：旧 continuation 不得 commit
      if (!this.scope.isCurrent(this.scopeGen)) {
        throw new Error('TaskScope closed before step commit')
      }

      const finishedAt = nowIso()
      const committed: StepRecord = {
        ...running,
        status: 'committed',
        output,
        finishedAt
      }
      writeStepRecord(this.workspaceRoot, this.runId, committed)
      appendV2Event(this.workspaceRoot, this.runId, {
        t: 'step_committed',
        stepId: def.id,
        inputHash,
        at: finishedAt
      })
      this.outputs.set(def.id, output)
      return output
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      const finishedAt = nowIso()
      // 仅在 scope 仍有效时落 failed（cancel 时由上层标 cancelled）
      if (this.scope.isCurrent(this.scopeGen)) {
        const failed: StepRecord = {
          ...running,
          status: 'failed',
          error,
          finishedAt
        }
        writeStepRecord(this.workspaceRoot, this.runId, failed)
        appendV2Event(this.workspaceRoot, this.runId, {
          t: 'step_failed',
          stepId: def.id,
          inputHash,
          error,
          at: finishedAt
        })
      }
      throw err
    }
  }

  private setRunStatus(status: WorkflowV2Manifest['status']): void {
    this.manifest.status = status
    this.manifest.updatedAt = nowIso()
    writeManifest(this.workspaceRoot, this.manifest)
    appendV2Event(this.workspaceRoot, this.runId, {
      t: 'run_status',
      status,
      at: nowIso()
    })
  }

  getManifest(): WorkflowV2Manifest {
    return { ...this.manifest }
  }
}

/** 从磁盘构建 resume 预览（无需完整 def） */
export function buildResumePlanFromDisk(
  workspaceRoot: string,
  runId: string,
  rerunFromStepId?: string
): ResumePlan | null {
  const manifest = readManifest(workspaceRoot, runId)
  if (!manifest) return null
  const records = new Map(
    listStepRecords(workspaceRoot, runId).map((r) => [r.stepId, r])
  )
  const skip: ResumePlan['skip'] = []
  const run: ResumePlan['run'] = []
  const blocked: ResumePlan['blocked'] = []
  let force = false
  const from = rerunFromStepId ?? manifest.rerunFromStepId

  for (const id of manifest.stepIds) {
    if (from && id === from) force = true
    const rec = records.get(id)
    const kind: StepKind = rec?.kind ?? 'custom'
    if (force) {
      run.push({ stepId: id, kind, status: rec?.status ?? 'pending' })
      continue
    }
    if (rec?.status === 'committed') {
      skip.push({ stepId: id, kind, status: 'committed' })
    } else if (rec?.status === 'failed' && !(rec.policy.retryable ?? true)) {
      blocked.push({ stepId: id, kind, error: rec.error })
    } else {
      run.push({ stepId: id, kind, status: rec?.status ?? 'pending' })
    }
  }
  return { skip, run, blocked }
}
