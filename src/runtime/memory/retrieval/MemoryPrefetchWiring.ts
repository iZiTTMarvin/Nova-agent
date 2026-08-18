/**
 * prefetch 请求注入接线：把检索块作为 ephemeral user 消息插入当次模型请求，
 * 位置紧邻当前用户消息之前，读作该轮上下文。
 *
 * 缓存与生命周期约束（改这里必须重估）：
 * - 块每 turn 只检索一次并跨轮复用：注入内容与位置在轮内不变，后一轮请求是
 *   前一轮请求的字节前缀延长，不破坏轮内缓存扩展；也不触碰 system prompt、
 *   frozenPrompt 与 prompt cache routing key。
 * - 注入消息带 skipCacheMarker，只存在于 hook 返回的请求副本，绝不进入
 *   ctx.messages / SessionStore / compaction 输入 / 提炼输入投影。
 * - 检索带硬超时；任何故障或超时都降级为不注入，绝不阻塞回合。
 *
 * 由宿主（AgentRuntimeFactory）把两个 handler 注册到 loop 的 HookManager；
 * memoryEnabled=false 或服务不可用时完全不注册。
 */
import type { ChatMessage } from '../../model/types'
import type { HookHandler } from '../../agent/core/HookManager'
import { MEMORY_PREFETCH_TIMEOUT_MS } from '../memoryConfig'

/** prefetch 窄端口；MemoryPrefetchService 结构性满足 */
export interface MemoryPrefetchPort {
  buildInjectionBlock(input: {
    query: string
    projectScopeId: string
    workspaceRoot?: string
  }): Promise<string | null>
}

export interface MemoryPrefetchWiringInput {
  prefetch: MemoryPrefetchPort
  projectScopeId: string
  workspaceRoot?: string
  /** 检索硬超时（毫秒）；默认取集中配置，测试可覆写 */
  timeoutMs?: number
}

export interface MemoryPrefetchWiring {
  /** 记录本轮 query（用户原始输入，不含 sessionPrefix / modeInstruction）并重置轮内状态 */
  onMessageStart: HookHandler<'onMessageStart'>
  /** 首次请求时检索一次，之后每轮把同一块插到当前用户消息之前 */
  context: HookHandler<'context'>
}

interface TurnPrefetchState {
  messageId: string
  query: string
  blockPromise: Promise<string | null> | null
  block: string | null
  /** 本轮用户消息（引用识别，首次请求时捕获）；被压缩等重写丢失后本轮不再注入 */
  turnUserMessage: ChatMessage | null
}

export function createMemoryPrefetchWiring(input: MemoryPrefetchWiringInput): MemoryPrefetchWiring {
  const timeoutMs = input.timeoutMs ?? MEMORY_PREFETCH_TIMEOUT_MS
  let turn: TurnPrefetchState | null = null

  const onMessageStart: HookHandler<'onMessageStart'> = (payload) => {
    turn = {
      messageId: payload.messageId,
      query: payload.text,
      blockPromise: null,
      block: null,
      turnUserMessage: null
    }
  }

  const context: HookHandler<'context'> = async (payload) => {
    if (!turn || turn.messageId !== payload.messageId) return undefined
    if (!turn.query.trim()) return undefined

    if (!turn.blockPromise) {
      turn.blockPromise = raceWithTimeout(
        input.prefetch.buildInjectionBlock({
          query: turn.query,
          projectScopeId: input.projectScopeId,
          workspaceRoot: input.workspaceRoot
        }),
        timeoutMs
      )
    }
    // 已完成的 Promise 重复 await 无额外开销；失败/超时解析为 null 后保持跳过
    const block = (turn.block = await turn.blockPromise)
    if (!block) return undefined

    if (!turn.turnUserMessage) {
      const last = payload.messages[payload.messages.length - 1]
      // 首次请求时末尾必须是本轮 user 消息；形态不符则放弃本轮注入（fail-soft）
      if (!last || last.role !== 'user') return undefined
      turn.turnUserMessage = last
    }
    const idx = payload.messages.indexOf(turn.turnUserMessage)
    // 压缩重写等导致引用丢失：本轮剩余请求不再注入，下一 turn 重新检索
    if (idx < 0) return undefined

    const ephemeral: ChatMessage = { role: 'user', content: block, skipCacheMarker: true }
    return {
      messages: [
        ...payload.messages.slice(0, idx),
        ephemeral,
        ...payload.messages.slice(idx)
      ]
    }
  }

  return { onMessageStart, context }
}

/** 超时或异常都解析为 null（buildInjectionBlock 自身已吞检索错误，这里只兜挂起与未知拒绝） */
function raceWithTimeout(promise: Promise<string | null>, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      }
    )
  })
}
