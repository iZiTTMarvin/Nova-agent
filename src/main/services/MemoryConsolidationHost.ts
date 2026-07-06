/**
 * MemoryConsolidationHost — working buffer drain 与 episodic 落盘调度
 *
 * 防竞态铁律：所有触发点先同步 drainWorkingBuffer 拿快照，再 setImmediate/同步写盘。
 * 落盘门控：memoryCaptureEnabled && memoryEpisodicSummaryEnabled（且 memoryEnabled）。
 */
import { computeWorkspaceHash } from '../../runtime/memory/MemoryPaths'
import { consolidateObservations } from '../../runtime/memory/MemoryConsolidator'
import {
  getObservationCaptureForSession,
  removeObservationCaptureForSession,
  type MemoryObservation
} from '../../runtime/memory/ObservationCapture'
import { loadNovaSettings } from '../../runtime/settings/novaSettings'
import { getMemoryService } from './MemoryServiceHost'

/**
 * episodic 落盘开关：开启记忆即启用。
 * 子开关默认全 true，由 memoryEnabled 一键统控。
 */
export function isEpisodicPersistEnabled(): boolean {
  return loadNovaSettings().memoryEnabled
}

/** 将 observation 快照巩固并写入 episodic/summary.md */
export function persistObservationsSnapshot(
  scopeId: string,
  observations: readonly MemoryObservation[]
): void {
  if (observations.length === 0) {
    return
  }
  const markdown = consolidateObservations(observations)
  if (!markdown.trim()) {
    return
  }
  getMemoryService().appendEpisodicSummary(scopeId, markdown)
}

/**
 * 同步 drain 快照；落盘开关开时 setImmediate 写盘（fire-and-forget）。
 * 开关关时仅 drain 丢弃，不写盘。
 */
export function drainAndSchedulePersist(sessionId: string, workspaceRoot: string): void {
  const capture = getObservationCaptureForSession(sessionId)
  const snapshot = capture.drainWorkingBuffer(sessionId)
  if (snapshot.length === 0) {
    return
  }
  if (!isEpisodicPersistEnabled()) {
    return
  }

  const scopeId = computeWorkspaceHash(workspaceRoot)
  setImmediate(() => {
    try {
      persistObservationsSnapshot(scopeId, snapshot)
    } catch (err) {
      console.error(`[MemoryConsolidation] session ${sessionId} 落盘失败:`, err)
    }
  })
}

/** 应用退出路径：同步 drain + 同步写盘（setImmediate 不保证执行） */
export function drainAndPersistSync(sessionId: string, workspaceRoot: string): void {
  const capture = getObservationCaptureForSession(sessionId)
  const snapshot = capture.drainWorkingBuffer(sessionId)
  if (snapshot.length === 0 || !isEpisodicPersistEnabled()) {
    return
  }
  const scopeId = computeWorkspaceHash(workspaceRoot)
  try {
    persistObservationsSnapshot(scopeId, snapshot)
  } catch (err) {
    console.error(`[MemoryConsolidation] 退出落盘失败 session=${sessionId}:`, err)
  }
}

/** 仅 drain 清空 buffer，不写盘 */
export function drainSessionBufferOnly(sessionId: string): void {
  getObservationCaptureForSession(sessionId).drainWorkingBuffer(sessionId)
}

/** buffer 超限：同步 drain 后 fire-and-forget 落盘 */
export function handleBufferOverflow(sessionId: string, workspaceRoot: string): void {
  const capture = getObservationCaptureForSession(sessionId)
  const snapshot = capture.drainWorkingBuffer(sessionId)
  if (snapshot.length === 0) {
    return
  }
  if (!isEpisodicPersistEnabled()) {
    return
  }
  const scopeId = computeWorkspaceHash(workspaceRoot)
  setImmediate(() => {
    try {
      persistObservationsSnapshot(scopeId, snapshot)
    } catch (err) {
      console.error(`[MemoryConsolidation] buffer 溢出落盘失败:`, err)
    }
  })
}

/** 会话采集收尾：清 buffer/pending 并移除注册表 */
export function cleanupObservationCaptureSession(sessionId: string): void {
  const capture = getObservationCaptureForSession(sessionId)
  capture.clearSession(sessionId)
  removeObservationCaptureForSession(sessionId)
}

/**
 * 为会话准备 ObservationCapture（含 buffer 溢出回调）。
 * agentHandler 在 memoryCaptureEnabled 时调用。
 */
export function ensureObservationCaptureForSession(
  sessionId: string,
  workspaceRoot: string
): void {
  const capture = getObservationCaptureForSession(sessionId)
  capture.setOnBufferOverflow(() => {
    handleBufferOverflow(sessionId, workspaceRoot)
  })
}

/** 退出前巩固当前会话 working buffer */
export function flushCurrentSessionOnQuit(
  sessionId: string | null,
  workspaceRoot: string | null
): void {
  if (!sessionId || !workspaceRoot?.trim()) {
    return
  }
  drainAndPersistSync(sessionId, workspaceRoot)
}
