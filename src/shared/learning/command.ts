import {
  LEARNING_MAX_COMMAND_ID_LENGTH,
  LEARNING_MAX_NODE_ID_LENGTH,
  LEARNING_MAX_OPTION_IDS,
  LEARNING_MAX_OPTION_ID_LENGTH,
  LEARNING_MAX_TEXT_LENGTH
} from './limits'

export type LearningAction =
  | { type: 'select_node'; nodeId: string }
  | { type: 'message'; text: string }
  | { type: 'answer'; checkpointId: string; text: string; optionIds: readonly string[] }
  | { type: 'hint'; checkpointId: string }
  | { type: 'explain'; checkpointId: string }
  | { type: 'skip'; checkpointId: string }
  | { type: 'dispute'; assessmentId: string; reason: string }
  | { type: 'resume' }
  /** 从开发会话的一条助手回复发起；改动文件由主进程从该消息的写入记录推导。 */
  | { type: 'explain_change'; devSessionId: string; devMessageId: string }

export interface LearningCommand {
  readonly commandId: string
  readonly sessionId: string
  readonly expectedClearGeneration: number
  readonly expectedCursorVersion: number
  readonly action: LearningAction
}

export type LearningCommandReceipt =
  | { ok: true; commandId: string; cursorVersion: number; applied: boolean }
  | { ok: false; code: 'stale' | 'busy' | 'invalid' | 'unavailable'; message: string }

function readBoundedString(
  value: unknown,
  field: string,
  maxLength: number
): string {
  if (typeof value !== 'string') {
    throw new Error(`learning: ${field} 必须是字符串`)
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength) {
    throw new Error(`learning: ${field} 长度无效`)
  }
  return trimmed
}

function readNonNegativeInt(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`learning: ${field} 必须是非负整数`)
  }
  return value as number
}

function parseOptionIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error('learning: optionIds 必须是数组')
  }
  if (value.length > LEARNING_MAX_OPTION_IDS) {
    throw new Error('learning: optionIds 超出上限')
  }
  const ids: string[] = []
  for (const item of value) {
    ids.push(readBoundedString(item, 'optionId', LEARNING_MAX_OPTION_ID_LENGTH))
  }
  return ids
}

export function parseLearningAction(raw: unknown): LearningAction {
  if (!raw || typeof raw !== 'object') {
    throw new Error('learning: action 必须是对象')
  }
  const value = raw as Record<string, unknown>
  const type = value.type
  switch (type) {
    case 'select_node':
      return {
        type: 'select_node',
        nodeId: readBoundedString(value.nodeId, 'nodeId', LEARNING_MAX_NODE_ID_LENGTH)
      }
    case 'message':
      return {
        type: 'message',
        text: readBoundedString(value.text, 'text', LEARNING_MAX_TEXT_LENGTH)
      }
    case 'answer':
      return {
        type: 'answer',
        checkpointId: readBoundedString(value.checkpointId, 'checkpointId', LEARNING_MAX_NODE_ID_LENGTH),
        text: readBoundedString(value.text, 'text', LEARNING_MAX_TEXT_LENGTH),
        optionIds: parseOptionIds(value.optionIds ?? [])
      }
    case 'hint':
    case 'explain':
    case 'skip':
      return {
        type,
        checkpointId: readBoundedString(value.checkpointId, 'checkpointId', LEARNING_MAX_NODE_ID_LENGTH)
      }
    case 'dispute': {
      // 理由可以不填：界面允许直接表达「我觉得我答对了」
      if (typeof value.reason !== 'string') throw new Error('learning: reason 必须是字符串')
      const reason = value.reason.trim()
      if (reason.length > LEARNING_MAX_TEXT_LENGTH) throw new Error('learning: reason 长度无效')
      return {
        type: 'dispute',
        assessmentId: readBoundedString(value.assessmentId, 'assessmentId', LEARNING_MAX_NODE_ID_LENGTH),
        reason
      }
    }
    case 'resume':
      return { type: 'resume' }
    case 'explain_change':
      return {
        type: 'explain_change',
        devSessionId: readBoundedString(value.devSessionId, 'devSessionId', LEARNING_MAX_COMMAND_ID_LENGTH),
        devMessageId: readBoundedString(value.devMessageId, 'devMessageId', LEARNING_MAX_COMMAND_ID_LENGTH)
      }
    default:
      throw new Error(`learning: 未知 action 类型 ${String(type)}`)
  }
}

export function parseLearningCommand(raw: unknown): LearningCommand {
  if (!raw || typeof raw !== 'object') {
    throw new Error('learning: command 必须是对象')
  }
  const value = raw as Record<string, unknown>
  return {
    commandId: readBoundedString(value.commandId, 'commandId', LEARNING_MAX_COMMAND_ID_LENGTH),
    sessionId: readBoundedString(value.sessionId, 'sessionId', LEARNING_MAX_COMMAND_ID_LENGTH),
    expectedClearGeneration: readNonNegativeInt(value.expectedClearGeneration, 'expectedClearGeneration'),
    expectedCursorVersion: readNonNegativeInt(value.expectedCursorVersion, 'expectedCursorVersion'),
    action: parseLearningAction(value.action)
  }
}

export function parseLearningCommandReceipt(raw: unknown): LearningCommandReceipt {
  if (!raw || typeof raw !== 'object') {
    throw new Error('learning: receipt 必须是对象')
  }
  const value = raw as Record<string, unknown>
  if (value.ok === true) {
    return {
      ok: true,
      commandId: readBoundedString(value.commandId, 'commandId', LEARNING_MAX_COMMAND_ID_LENGTH),
      cursorVersion: readNonNegativeInt(value.cursorVersion, 'cursorVersion'),
      applied: value.applied === true
    }
  }
  if (value.ok === false) {
    const code = value.code
    if (code !== 'stale' && code !== 'busy' && code !== 'invalid' && code !== 'unavailable') {
      throw new Error('learning: receipt code 非法')
    }
    return {
      ok: false,
      code,
      message: readBoundedString(value.message, 'message', LEARNING_MAX_TEXT_LENGTH)
    }
  }
  throw new Error('learning: receipt ok 字段非法')
}
