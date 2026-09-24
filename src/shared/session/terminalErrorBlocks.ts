/**
 * 终态错误并入消息 blocks：主进程落盘与渲染层 UI 共用，避免文案/标错逻辑分叉。
 */
import { parseModelFailureError, type ModelFailureKind } from '../model/failureKinds'

export const TERMINAL_ERROR_NOTICE_PREFIX = '⚠️ '
export const CONTEXT_BUDGET_EXCEEDED_NOTICE =
  '对话内容已超过模型上下文预算。请移除部分图片、缩短消息，或新建会话后重试。'
/** 已拿到响应头后断流：请求可能已送达，不能改写成「网络连不上」或提供重试 */
export const REMOTE_RESULT_UNKNOWN_NOTICE = '远端结果与费用未知，已停止自动重试。'

/** 错误恢复动作：展示侧据此渲染按钮，语义跨端一致 */
export type TerminalErrorAction =
  | 'open-settings'
  | 'retry'
  | 'switch-model'
  | 'new-session'
  | 'export-diagnostics'

/** 每类失败的用户文案与建议动作；文案说人话，动作可执行 */
const MODEL_FAILURE_PRESENTATIONS: Record<ModelFailureKind, { text: string; actions: TerminalErrorAction[] }> = {
  auth: { text: 'API Key 不对或已失效，请到设置里检查服务商配置。', actions: ['open-settings'] },
  provider_billing: { text: '服务商账户余额不足或已欠费，充值后即可恢复。', actions: ['open-settings'] },
  rate_limit: { text: '触发了服务商限流，稍等会自动重试；也可以先换个模型。', actions: ['retry', 'switch-model'] },
  network: { text: '网络连不上服务商，请检查网络或代理设置后重试。', actions: ['retry'] },
  timeout: { text: '服务商响应超时了，重试通常可以解决。', actions: ['retry'] },
  context_overflow: { text: CONTEXT_BUDGET_EXCEEDED_NOTICE, actions: ['new-session'] },
  provider_unavailable: { text: '服务商暂时不可用，可以换个模型或稍后再试。', actions: ['switch-model'] },
  unknown: { text: '出了个没识别出来的问题，可以导出诊断包帮忙定位。', actions: ['export-diagnostics'] }
}

function isRemoteResultUnknown(message: string): boolean {
  return message.includes(REMOTE_RESULT_UNKNOWN_NOTICE)
}

/** 将内部预算错误转换为用户可执行的提示，其他错误保留原文。 */
export function formatTerminalErrorMessage(error: string): string {
  const modelFailure = parseModelFailureError(error)
  if (modelFailure) {
    // unknown 分类可能包裹更具体的旧家族错误（如压缩链抛的 ContextBudgetExceeded）；
    // 内层能翻出更准确指引时优先内层
    if (modelFailure.kind === 'unknown') {
      const inner = formatTerminalErrorMessage(modelFailure.message)
      if (inner !== modelFailure.message) return inner
    }
    if (isRemoteResultUnknown(modelFailure.message)) return REMOTE_RESULT_UNKNOWN_NOTICE
    return MODEL_FAILURE_PRESENTATIONS[modelFailure.kind].text
  }
  if (error.startsWith('ContextRecoveryFailed:')) {
    const reason = error.slice('ContextRecoveryFailed:'.length).trim()
    // 执行权被接管不是失败，不提示重试（新请求已在处理）。
    if (reason === 'authority-expired') return '本轮执行已被新的请求接管，历史保持不变。'
    const detail = reason === 'invalid-summary' ? '模型返回的历史摘要未通过完整性校验'
      : reason === 'empty-summary' ? '模型没有返回历史摘要'
      : reason === 'request-overflow' ? '摘要请求超过模型可接收的上下文'
      : reason === 'summary-budget' ? '历史摘要仍超出可用预算'
      : reason === 'commit-rejected' ? '历史摘要未能安全保存'
      : reason === 'stale-context' ? '会话上下文已变化，旧摘要未被采纳'
      : '历史摘要请求失败'
    return `${detail}，本轮已停止。原始记录已保留，可重试继续任务。`
  }
  return error.startsWith('ContextBudgetExceeded:')
    ? CONTEXT_BUDGET_EXCEEDED_NOTICE
    : error
}

/** 从终态错误文本解析建议动作；无分类前缀的错误没有按钮。 */
export function resolveTerminalErrorActions(error: string): TerminalErrorAction[] {
  const modelFailure = parseModelFailureError(error)
  if (!modelFailure) {
    // 旧家族前缀没有 ModelFailure 分类，但语义明确：与文案翻译保持同一映射
    if (error.startsWith('ContextBudgetExceeded:')) return ['new-session']
    return []
  }
  if (isRemoteResultUnknown(modelFailure.message)) return []
  // unknown 包裹更具体错误时（如压缩链抛的 ContextBudgetExceeded），跟随内层语义给动作，
  // 与 formatTerminalErrorMessage 的内层回退保持一致
  if (modelFailure.kind === 'unknown') {
    const innerActions = resolveTerminalErrorActions(modelFailure.message)
    if (innerActions.length > 0) return innerActions
  }
  return MODEL_FAILURE_PRESENTATIONS[modelFailure.kind].actions
}

/** 生成终态错误提示文案（含统一前缀） */
export function formatTerminalErrorNotice(error: string): string {
  return `${TERMINAL_ERROR_NOTICE_PREFIX}${formatTerminalErrorMessage(error)}`
}

/** 可被本函数处理的最小 block 形状（兼容 MessageBlock / RendererMessageBlock） */
export type TerminalErrorBlockLike = {
  type: string
  content?: string
  status?: string
  result?: string
}

/**
 * 将终态错误并入 blocks：
 * - running / 无 status 的 tool → status=error，result=翻译后文案
 * - 末尾已是 text → 拼接提示；否则新增 text 块
 */
export function appendTerminalErrorToBlocks<T extends TerminalErrorBlockLike>(
  blocks: readonly T[],
  error: string
): T[] {
  const notice = formatTerminalErrorNotice(error)
  // tool 行的 result 同样出翻译后文案：分类前缀是机器协议，不给用户看
  const display = formatTerminalErrorMessage(error)
  const out = blocks.map(b => {
    if (b.type === 'tool' && (b.status === 'running' || !b.status)) {
      return { ...b, status: 'error', result: display }
    }
    return b
  })

  const last = out[out.length - 1]
  if (last && last.type === 'text' && typeof last.content === 'string') {
    out[out.length - 1] = {
      ...last,
      content: `${last.content}\n\n${notice}`
    }
  } else {
    out.push({ type: 'text', content: notice } as T)
  }
  return out
}
