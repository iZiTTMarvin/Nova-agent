/**
 * XForge 领域状态服务：阶段转移合法性、state patch、waiting/resume，
 * 以及到通用 run status/progress/terminal 的投影。
 *
 * 不持有第二份 run 状态；落盘与 journal 一律经 RunCoordinator 的 feature 提交端口。
 */

import type {
  FeatureCommitAuthority,
  RunCoordinator
} from '../../run/RunCoordinator'
import type { RunProgress, RunSnapshot, RunStatus, StartRunParams } from '../../../shared/run/types'
import {
  applyXForgeStatePatch,
  applyXForgeStageTransition,
  cloneXForgeRunState,
  createInitialXForgeRunState,
  type ApplyXForgeTransitionOptions,
  type XForgeRunCommitter,
  type XForgeRunState
} from './runState'
import { isTerminalStage } from './stageController'
import type { StageTransitionResult } from './types'

export type CommitXForgeStageResult =
  | { ok: true; snapshot: RunSnapshot; xforge: XForgeRunState }
  | {
      ok: false
      code:
        | 'not_found'
        | 'run_ended'
        | 'not_xforge'
        | 'xforge_terminal'
        | 'transition_rejected'
        | 'from_mismatch'
        | 'stale_execution'
        | 'sequence_mismatch'
      message: string
      snapshot?: RunSnapshot
    }

export type CommitXForgeStatePatchResult =
  | { ok: true; snapshot: RunSnapshot; xforge: XForgeRunState }
  | {
      ok: false
      code:
        | 'not_found'
        | 'run_ended'
        | 'not_xforge'
        | 'xforge_terminal'
        | 'transition_rejected'
        | 'stale_execution'
        | 'sequence_mismatch'
      message: string
      snapshot?: RunSnapshot
    }

export class XForgeRunService {
  constructor(private readonly coordinator: RunCoordinator) {}

  /** 为一次真实执行绑定 generation；执行期的所有领域提交都经此端口。 */
  createExecutionCommitter(generation: number): XForgeRunCommitter {
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new Error(`非法 execution generation: ${generation}`)
    }
    const authority: FeatureCommitAuthority = { kind: 'execution', generation }
    return {
      getSnapshot: runId => this.getSnapshot(runId),
      commitXForgeStageTransition: (runId, result, opts) =>
        this.commitXForgeStageTransition(runId, result, authority, opts),
      commitXForgeStatePatch: (runId, opts, reason) =>
        this.commitXForgeStatePatch(runId, opts, authority, reason)
    }
  }

  getSnapshot(runId: string): { xforge?: XForgeRunState | null } | null {
    return this.coordinator.getSnapshot(runId)
  }

  /**
   * 启动 XForge Stage Run：kind=xforge，snapshot 带初始阶段状态。
   * 本方法只落权威状态，不执行 Agent / workflow。
   */
  startXForgeRun(
    params: Omit<StartRunParams, 'kind' | 'xforge'> & {
      xforge?: XForgeRunState
      reviewOnly?: boolean
    }
  ): RunSnapshot {
    const initial =
      params.xforge ??
      createInitialXForgeRunState({
        reviewOnly: params.reviewOnly
      })
    return this.coordinator.startRun({
      runId: params.runId,
      kind: 'xforge',
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      messageId: params.messageId,
      xforge: initial
    })
  }

  /**
   * 将 StageTransitionResult 原子写入 RunSnapshot.xforge。
   * 硬终态 run / XForge 终态阶段拒绝更新；失败 transition 不落盘。
   */
  private commitXForgeStageTransition(
    runId: string,
    result: StageTransitionResult,
    authority: FeatureCommitAuthority,
    opts: ApplyXForgeTransitionOptions = {}
  ): CommitXForgeStageResult {
    const gate = this.requireMutableXForge(runId)
    if (!gate.ok) return gate

    const { snap, xforge } = gate
    if (isTerminalStage(xforge.currentStage)) {
      return {
        ok: false,
        code: 'xforge_terminal',
        message: `XForge 终态 ${xforge.currentStage} 不可再更新`,
        snapshot: snap
      }
    }

    const applied = applyXForgeStageTransition(xforge, result, opts)
    if (!applied.ok) {
      return {
        ok: false,
        code: applied.code,
        message: applied.reason,
        snapshot: snap
      }
    }

    const projection = projectRunFromXForge(snap, applied.state)
    const committed = this.coordinator.commitFeatureUpdate({
      runId,
      feature: { kind: 'xforge', state: applied.state },
      authority,
      eventType: 'xforge_stage_commit',
      eventPayload: {
        from: result.ok ? result.from : undefined,
        to: result.ok ? result.to : undefined,
        reason: result.reason
      },
      projection
    })

    if (!committed.ok) {
      return {
        ok: false,
        code: committed.code === 'kind_mismatch' ? 'not_xforge' : committed.code,
        message: committed.message,
        snapshot: committed.snapshot
      }
    }

    return {
      ok: true,
      snapshot: committed.snapshot,
      xforge: cloneXForgeRunState(applied.state)
    }
  }

  /**
   * 原子更新 XForge 同阶段事实（任务尝试、写入边界、证据等）。
   * 不改变 currentStage。
   */
  private commitXForgeStatePatch(
    runId: string,
    opts: ApplyXForgeTransitionOptions,
    authority: FeatureCommitAuthority,
    reason = 'XForge 状态更新'
  ): CommitXForgeStatePatchResult {
    const gate = this.requireMutableXForge(runId)
    if (!gate.ok) return gate

    const { snap, xforge } = gate
    if (isTerminalStage(xforge.currentStage)) {
      return {
        ok: false,
        code: 'xforge_terminal',
        message: `XForge 终态 ${xforge.currentStage} 不可再更新`,
        snapshot: snap
      }
    }

    const next = applyXForgeStatePatch(xforge, opts, reason)
    const projection = projectRunFromXForge(snap, next)
    const committed = this.coordinator.commitFeatureUpdate({
      runId,
      feature: { kind: 'xforge', state: next },
      authority,
      eventType: 'xforge_state_patch',
      eventPayload: { reason },
      projection
    })

    if (!committed.ok) {
      return {
        ok: false,
        code: committed.code === 'kind_mismatch' ? 'not_xforge' : committed.code,
        message: committed.message,
        snapshot: committed.snapshot
      }
    }

    return {
      ok: true,
      snapshot: committed.snapshot,
      xforge: cloneXForgeRunState(next)
    }
  }

  /**
   * 用用户的新输入恢复安全挂起的 XForge run。
   * 恢复目标只读自持久化 resumeTarget，调用方不能任意指定或绕过门禁。
   */
  resumeXForgeRun(runId: string, userDecision?: string): CommitXForgeStatePatchResult {
    const gate = this.requireMutableXForge(runId)
    if (!gate.ok) {
      if (gate.code === 'not_found') {
        return { ok: false, code: 'not_found', message: `run 不存在或已结束: ${runId}` }
      }
      return gate
    }

    const { snap, xforge: state } = gate
    if (state.currentStage !== 'waiting_user' || !state.resumeTarget) {
      return {
        ok: false,
        code: 'transition_rejected',
        message: `XForge 当前阶段 ${state.currentStage} 不可按 waiting_user 恢复`,
        snapshot: snap
      }
    }

    const next = cloneXForgeRunState(state)
    next.currentStage = state.resumeTarget
    next.suspendedStage = null
    next.resumeTarget = null
    next.waitingReason = null
    next.lastTransitionReason = `用户输入后恢复到 ${next.currentStage}`
    if (userDecision?.trim()) {
      next.mainSession.userDecisions.push(userDecision.trim())
    }

    const committed = this.coordinator.commitFeatureUpdate({
      runId,
      feature: { kind: 'xforge', state: next },
      authority: { kind: 'host', expectedSequence: snap.sequence },
      eventType: 'xforge_state_patch',
      eventPayload: { reason: next.lastTransitionReason },
      projection: {
        status: 'running',
        progress: { label: `XForge：${next.currentStage}` }
      }
    })

    if (!committed.ok) {
      return {
        ok: false,
        code: committed.code === 'kind_mismatch' ? 'not_xforge' : committed.code,
        message: committed.message,
        snapshot: committed.snapshot
      }
    }

    return {
      ok: true,
      snapshot: committed.snapshot,
      xforge: cloneXForgeRunState(next)
    }
  }

  cancelParkedXForgeRun(
    runId: string,
    reason: string
  ): CommitXForgeStageResult {
    const existing = this.coordinator.getSnapshot(runId)
    if (!existing) {
      return { ok: false, code: 'not_found', message: `run 不存在: ${runId}` }
    }
    if (existing.kind !== 'xforge' || !existing.xforge) {
      return {
        ok: false,
        code: 'not_xforge',
        message: '仅 kind=xforge 的 run 可取消阶段状态',
        snapshot: existing
      }
    }
    return this.commitXForgeStageTransition(
      runId,
      {
        ok: true,
        from: existing.xforge.currentStage,
        to: 'cancelled',
        reason
      },
      { kind: 'host', expectedSequence: existing.sequence }
    )
  }

  private requireMutableXForge(
    runId: string
  ):
    | { ok: true; snap: RunSnapshot; xforge: XForgeRunState }
    | {
        ok: false
        code: 'not_found' | 'run_ended' | 'not_xforge'
        message: string
        snapshot?: RunSnapshot
      } {
    const existing = this.coordinator.getSnapshot(runId)
    if (!existing) {
      return { ok: false, code: 'not_found', message: `run 不存在: ${runId}` }
    }

    if (!this.coordinator.isMutableRun(runId)) {
      return {
        ok: false,
        code: 'run_ended',
        message: `run 已终态，拒绝阶段更新（status=${existing.status}）`,
        snapshot: existing
      }
    }

    if (existing.kind !== 'xforge' || !existing.xforge) {
      return {
        ok: false,
        code: 'not_xforge',
        message: '仅 kind=xforge 的 run 可提交阶段转移',
        snapshot: existing
      }
    }

    return { ok: true, snap: existing, xforge: existing.xforge }
  }
}

/** 将 XForge 阶段投影为通用 run status / progress / terminal 语义 */
export function projectRunFromXForge(
  snap: RunSnapshot,
  xforge: XForgeRunState
): {
  status: RunStatus
  progress: RunProgress | null
  terminalReason?: string
  cancelPendingInteractions?: boolean
} {
  if (xforge.currentStage === 'waiting_user') {
    const status: RunStatus =
      snap.status === 'running' || snap.status === 'retrying' ? 'waiting_user' : snap.status
    return {
      status,
      progress: xforge.waitingReason
        ? {
            ...(snap.progress ?? {}),
            label: xforge.waitingReason
          }
        : snap.progress
    }
  }

  if (
    xforge.currentStage === 'completed' ||
    xforge.currentStage === 'failed' ||
    xforge.currentStage === 'cancelled'
  ) {
    return {
      status: xforge.currentStage,
      progress: snap.progress,
      terminalReason: xforge.lastTransitionReason ?? snap.terminalReason,
      cancelPendingInteractions: true
    }
  }

  return {
    status: snap.status,
    progress: snap.progress
  }
}
