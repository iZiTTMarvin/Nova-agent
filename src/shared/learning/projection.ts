import { LEARNING_MAX_COMMAND_ID_LENGTH } from './limits'

/** 学习投影最小身份；projectId 由主进程工作区解析，不接受 Renderer 自报。 */
export interface LearningProjectionIdentity {
  readonly sessionId: string
  readonly projectionRevision: number
}

/** 服务端签发的清除代次；命令只回传预期值。 */
export interface LearningClearGenerationView {
  readonly clearGeneration: number
}

export function parseLearningProjectionIdentity(raw: unknown): LearningProjectionIdentity {
  if (!raw || typeof raw !== 'object') {
    throw new Error('learning: projection identity 必须是对象')
  }
  const value = raw as Record<string, unknown>
  if (typeof value.sessionId !== 'string' || !value.sessionId.trim()) {
    throw new Error('learning: sessionId 无效')
  }
  if (value.sessionId.length > LEARNING_MAX_COMMAND_ID_LENGTH) {
    throw new Error('learning: sessionId 过长')
  }
  if (!Number.isSafeInteger(value.projectionRevision) || (value.projectionRevision as number) < 0) {
    throw new Error('learning: projectionRevision 无效')
  }
  return {
    sessionId: value.sessionId.trim(),
    projectionRevision: value.projectionRevision as number
  }
}

export function parseLearningClearGenerationView(raw: unknown): LearningClearGenerationView {
  if (!raw || typeof raw !== 'object') {
    throw new Error('learning: clearGeneration 视图必须是对象')
  }
  const value = raw as Record<string, unknown>
  if (!Number.isSafeInteger(value.clearGeneration) || (value.clearGeneration as number) < 0) {
    throw new Error('learning: clearGeneration 无效')
  }
  return { clearGeneration: value.clearGeneration as number }
}
