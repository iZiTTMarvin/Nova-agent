import type { CheckpointManager } from '../../checkpoints/CheckpointManager'
import {
  listFileEffectsDetailed,
  type FileEffectReceipt
} from '../v2/EffectReceipt'
import { createWorkspaceFingerprint } from './stageArtifacts'
import type {
  XForgeFileEffect,
  XForgeWorkspaceFingerprint,
  XForgeWriteBoundary
} from './runState'

/**
 * 为 implement/fix 建立真实写入边界。CheckpointManager 后续由 write/edit/bash 工具
 * 按文件写前备份；这里固定同一事务 id，并在任何业务写入前采集工作区摘要。
 */
export function prepareXForgeWriteBoundary(params: {
  checkpointManager: CheckpointManager
  workspaceRoot: string
  checkpointRef: string
  workspaceRevision: number
}): XForgeWriteBoundary {
  params.checkpointManager.beginMessage(params.checkpointRef)
  return {
    checkpointRef: params.checkpointRef,
    fingerprint: createWorkspaceFingerprint(params.workspaceRoot, {
      revision: params.workspaceRevision
    }),
    preparedAt: Date.now()
  }
}

export interface XForgeEffectInspection {
  effects: XForgeFileEffect[]
  pending: FileEffectReceipt[]
  corruptReceiptIds: string[]
}

/** 校验一次写入的 receipt 与写后指纹；任一不完整状态都禁止自动重放。 */
export function validateXForgeCommittedEffects(params: {
  effects?: XForgeFileEffect[]
  workspaceFingerprint?: XForgeWorkspaceFingerprint
  currentWorkspaceRevision: number
}): string | null {
  const effects = params.effects ?? []
  if (effects.length === 0) return null

  const missing = effects.find(effect => !effect.receiptId)
  if (missing) return `文件副作用缺少 EffectReceipt: ${missing.path}`

  const uncommitted = effects.find(effect => effect.status !== 'committed')
  if (uncommitted) return `EffectReceipt 未提交: ${uncommitted.path}`

  const fingerprint = params.workspaceFingerprint
  if (!fingerprint) return '工作区写入后缺少 Workspace Fingerprint'
  if (fingerprint.revision !== params.currentWorkspaceRevision + 1) {
    return `写入后 Fingerprint 版本 ${fingerprint.revision} 未递增到 ${params.currentWorkspaceRevision + 1}`
  }
  return null
}

/** 从持久化 EffectReceipt 读取任务副作用，模型返回值不参与可信判定。 */
export function inspectXForgeTaskEffects(params: {
  workspaceRoot: string
  runId: string
  taskId: string
}): XForgeEffectInspection {
  const result = listFileEffectsDetailed(params.workspaceRoot, params.runId)
  const receipts = result.effects.filter(receipt => receipt.stepId === params.taskId)
  return {
    effects: receipts.map(receipt => ({
      path: receipt.path,
      receiptId: receipt.effectId,
      status: receipt.status
    })),
    pending: receipts.filter(receipt => receipt.status !== 'committed'),
    corruptReceiptIds: result.corruptIds
  }
}
