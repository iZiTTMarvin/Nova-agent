import type {
  SpawnSubagentCommand,
  SubagentExecutionResult
} from '../../shared/subagents'
import type { SpawnSubagentContext, SpawnSubagentPort } from './ports'

export interface SubagentBatchItem {
  readonly itemKey: string
  readonly command: SpawnSubagentCommand
  readonly context?: SpawnSubagentContext
}

export type SubagentBatchItemResult =
  | {
      readonly itemKey: string
      readonly status: 'fulfilled'
      readonly result: SubagentExecutionResult
    }
  | {
      readonly itemKey: string
      readonly status: 'rejected'
      readonly error: string
    }

/**
 * Workflow 批次的薄消费者：itemKey 进入 durable taskId，成员用 allSettled 语义互不连坐。
 * 调度与并发仍全部由 SpawnSubagentPort 后的 SubagentScheduler 决定。
 */
export async function executeSubagentBatch(
  port: SpawnSubagentPort,
  items: readonly SubagentBatchItem[]
): Promise<SubagentBatchItemResult[]> {
  const seen = new Set<string>()
  const normalized = items.map((item) => {
    const itemKey = item.itemKey.trim()
    if (!itemKey) throw new Error('subagent batch itemKey 不能为空')
    if (seen.has(itemKey)) throw new Error(`subagent batch itemKey 重复: ${itemKey}`)
    seen.add(itemKey)
    if (item.command.invocation.kind !== 'workflow') {
      throw new Error('subagent batch 仅接受 workflow origin')
    }
    return {
      ...item,
      itemKey,
      command: {
        ...item.command,
        invocation: {
          ...item.command.invocation,
          taskId: itemKey
        }
      }
    }
  })

  return Promise.all(normalized.map(async (item): Promise<SubagentBatchItemResult> => {
    try {
      const result = await port.spawn(item.command, {
        ...(item.context ?? {}),
        waitForPermit: true
      })
      return { itemKey: item.itemKey, status: 'fulfilled', result }
    } catch (error) {
      return {
        itemKey: item.itemKey,
        status: 'rejected',
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }))
}
