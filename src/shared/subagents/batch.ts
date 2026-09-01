import type { ReasoningEffort } from '../config'
import type { SubagentExecutionFailure, SubagentExecutionResult, SubagentExecutionStatus } from './types'

export const BATCH_MAX_ITEMS = 4
export const BATCH_MIN_ITEMS = 2
export const BATCH_ITEM_ID_MAX_LENGTH = 64
export const BATCH_TASK_MAX_LENGTH = 8192

export const BATCH_ITEM_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/i

export interface BatchSubagentModelOverride {
  readonly providerId: string
  readonly modelEntryId: string
}

export interface BatchSubagentItem {
  readonly itemId: string
  readonly profileId: string
  readonly task: string
  readonly model?: BatchSubagentModelOverride
  readonly reasoningEffort?: ReasoningEffort
}

export interface BatchSubagentInput {
  readonly items: readonly BatchSubagentItem[]
}

export interface BatchSubagentItemResult {
  readonly itemId: string
  readonly childSessionId?: string
  readonly childRunId?: string
  readonly status: SubagentExecutionStatus | 'rejected'
  readonly summary?: string
  readonly failure?: SubagentExecutionFailure
  readonly incompleteReason?: SubagentExecutionResult['incompleteReason']
}

export interface BatchSubagentOutput {
  readonly results: readonly BatchSubagentItemResult[]
}

export interface BatchDecodeIssue {
  readonly field?: string
  readonly message: string
}

export class SubagentBatchDecodeError extends Error {
  readonly name = 'SubagentBatchDecodeError'
  constructor(readonly issues: BatchDecodeIssue[]) {
    super(issues.map((issue) => issue.message).join('；'))
  }
}

const REASONING_EFFORT_VALUES = ['auto', 'low', 'medium', 'high', 'max'] as const

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORT_VALUES as readonly string[]).includes(value)
}

export function decodeBatchInput(input: unknown): BatchSubagentInput {
  if (!isObject(input)) {
    throw new SubagentBatchDecodeError([{ message: '批次输入必须是 object' }])
  }
  const rawItems = input.items
  if (!Array.isArray(rawItems)) {
    throw new SubagentBatchDecodeError([{ field: 'items', message: '批次 items 必须是数组' }])
  }
  if (rawItems.length < BATCH_MIN_ITEMS || rawItems.length > BATCH_MAX_ITEMS) {
    throw new SubagentBatchDecodeError([
      {
        field: 'items',
        message: `批次项数必须在 ${BATCH_MIN_ITEMS}..${BATCH_MAX_ITEMS} 之间，当前 ${rawItems.length}`
      }
    ])
  }

  const issues: BatchDecodeIssue[] = []
  const seen = new Set<string>()
  const items: BatchSubagentItem[] = []
  for (let index = 0; index < rawItems.length; index += 1) {
    const raw = rawItems[index]
    const prefix = `items[${index}]`
    if (!isObject(raw)) {
      issues.push({ field: prefix, message: `${prefix} 必须是 object` })
      continue
    }
    const issueCount = issues.length
    const itemId = typeof raw.itemId === 'string' ? raw.itemId.trim() : ''
    if (!itemId) {
      issues.push({ field: `${prefix}.itemId`, message: `${prefix}.itemId 不能为空` })
    } else if (itemId.length > BATCH_ITEM_ID_MAX_LENGTH) {
      issues.push({ field: `${prefix}.itemId`, message: `${prefix}.itemId 长度不能超过 ${BATCH_ITEM_ID_MAX_LENGTH}` })
    } else if (!BATCH_ITEM_ID_PATTERN.test(itemId)) {
      issues.push({ field: `${prefix}.itemId`, message: `${prefix}.itemId 格式非法，仅允许字母、数字、"."、"_"、"-" 且首尾为字母或数字` })
    } else if (seen.has(itemId)) {
      issues.push({ field: `${prefix}.itemId`, message: `${prefix}.itemId 重复：${itemId}` })
    } else {
      seen.add(itemId)
    }

    const profileId = typeof raw.profileId === 'string' ? raw.profileId.trim() : ''
    if (!profileId) {
      issues.push({ field: `${prefix}.profileId`, message: `${prefix}.profileId 不能为空` })
    }

    const task = typeof raw.task === 'string' ? raw.task.trim() : ''
    if (!task) {
      issues.push({ field: `${prefix}.task`, message: `${prefix}.task 不能为空` })
    } else if (task.length > BATCH_TASK_MAX_LENGTH) {
      issues.push({ field: `${prefix}.task`, message: `${prefix}.task 长度不能超过 ${BATCH_TASK_MAX_LENGTH}` })
    }

    let model: BatchSubagentModelOverride | undefined
    if (raw.model !== undefined) {
      if (!isObject(raw.model)) {
        issues.push({ field: `${prefix}.model`, message: `${prefix}.model 必须是 { providerId, modelEntryId }` })
      } else {
        const providerId = typeof raw.model.providerId === 'string' ? raw.model.providerId.trim() : ''
        const modelEntryId = typeof raw.model.modelEntryId === 'string' ? raw.model.modelEntryId.trim() : ''
        if (!providerId || !modelEntryId) {
          issues.push({ field: `${prefix}.model`, message: `${prefix}.model 必须是包含非空 providerId 与 modelEntryId 的对象` })
        } else {
          model = { providerId, modelEntryId }
        }
      }
    }

    let reasoningEffort: ReasoningEffort | undefined
    if (raw.reasoningEffort !== undefined) {
      if (!isReasoningEffort(raw.reasoningEffort)) {
        issues.push({ field: `${prefix}.reasoningEffort`, message: `${prefix}.reasoningEffort 必须是 auto/low/medium/high/max 之一` })
      } else {
        reasoningEffort = raw.reasoningEffort
      }
    }

    if (issues.length === issueCount) {
      items.push({
        itemId,
        profileId,
        task,
        ...(model ? { model } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {})
      })
    }
  }

  if (issues.length > 0) {
    throw new SubagentBatchDecodeError(issues)
  }
  return { items: Object.freeze(items) }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
