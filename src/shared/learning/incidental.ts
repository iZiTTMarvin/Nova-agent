/**
 * 随堂学习契约形状（§21.6）：仅类型与解析，不实现斜杠命令或 UI。
 */

import { LEARNING_MAX_COMMAND_ID_LENGTH, LEARNING_MAX_NODE_ID_LENGTH } from './limits'

/** 项目级隐式随堂游标身份。 */
export interface IncidentalLearningCursorIdentity {
  readonly projectId: string
  readonly cursorVersion: number
}

/** 用户消息上的随堂标记；结构对齐 UserDeliveryFacts.skillInput 先例。 */
export interface IncidentalLearningMessageMark {
  readonly version: 1
  readonly sourceCommand: '/学习模式'
  readonly userQuestion: string
  readonly sourceMessageId: string
}

/** 回合级教学覆盖层贡献（装配层消费，kernel 不读）。 */
export interface IncidentalTurnOverlayContribution {
  readonly instructionAppend: string
  readonly extraVisibleToolNames: readonly string[]
}

/** 记忆排除粒度：session.mode=learn 或带随堂标记的消息范围。 */
export interface LearningMemoryExclusionScope {
  readonly sessionMode: 'learn' | 'default' | 'plan' | 'compose'
  readonly incidentalMessageIds: readonly string[]
}

export function parseIncidentalLearningMessageMark(raw: unknown): IncidentalLearningMessageMark {
  if (!raw || typeof raw !== 'object') {
    throw new Error('learning: 随堂标记必须是对象')
  }
  const value = raw as Record<string, unknown>
  if (value.version !== 1) {
    throw new Error('learning: 随堂标记 version 无效')
  }
  if (value.sourceCommand !== '/学习模式') {
    throw new Error('learning: 随堂标记 sourceCommand 无效')
  }
  if (typeof value.userQuestion !== 'string' || !value.userQuestion.trim()) {
    throw new Error('learning: userQuestion 无效')
  }
  if (typeof value.sourceMessageId !== 'string' || !value.sourceMessageId.trim()) {
    throw new Error('learning: sourceMessageId 无效')
  }
  if (value.userQuestion.length > 8_000 || value.sourceMessageId.length > LEARNING_MAX_COMMAND_ID_LENGTH) {
    throw new Error('learning: 随堂标记字段过长')
  }
  return {
    version: 1,
    sourceCommand: '/学习模式',
    userQuestion: value.userQuestion.trim(),
    sourceMessageId: value.sourceMessageId.trim()
  }
}

export function parseIncidentalLearningCursorIdentity(raw: unknown): IncidentalLearningCursorIdentity {
  if (!raw || typeof raw !== 'object') {
    throw new Error('learning: 随堂游标身份必须是对象')
  }
  const value = raw as Record<string, unknown>
  if (typeof value.projectId !== 'string' || !value.projectId.trim()) {
    throw new Error('learning: projectId 无效')
  }
  if (value.projectId.length > LEARNING_MAX_NODE_ID_LENGTH) {
    throw new Error('learning: projectId 过长')
  }
  if (!Number.isSafeInteger(value.cursorVersion) || (value.cursorVersion as number) < 0) {
    throw new Error('learning: cursorVersion 无效')
  }
  return {
    projectId: value.projectId.trim(),
    cursorVersion: value.cursorVersion as number
  }
}
