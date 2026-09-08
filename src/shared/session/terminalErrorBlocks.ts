/**
 * 终态错误并入消息 blocks：主进程落盘与渲染层 UI 共用，避免文案/标错逻辑分叉。
 */
export const TERMINAL_ERROR_NOTICE_PREFIX = '⚠️ '
export const CONTEXT_BUDGET_EXCEEDED_NOTICE =
  '对话内容已超过模型上下文预算。请移除部分图片、缩短消息，或新建会话后重试。'

/** 将内部预算错误转换为用户可执行的提示，其他错误保留原文。 */
export function formatTerminalErrorMessage(error: string): string {
  if (error.startsWith('ContextRecoveryFailed:')) {
    const reason = error.slice('ContextRecoveryFailed:'.length).trim()
    const detail = reason === 'invalid-summary' ? '模型返回的历史摘要未通过完整性校验'
      : reason === 'empty-summary' ? '模型没有返回历史摘要'
      : reason === 'request-overflow' ? '摘要请求超过模型可接收的上下文'
      : reason === 'summary-budget' ? '历史摘要仍超出可用预算'
      : reason === 'commit-rejected' ? '历史摘要未能安全保存'
      : '历史摘要请求失败'
    return `${detail}，本轮已停止。原始记录已保留，可重试继续任务。`
  }
  return error.startsWith('ContextBudgetExceeded:')
    ? CONTEXT_BUDGET_EXCEEDED_NOTICE
    : error
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
 * - running / 无 status 的 tool → status=error，result=错误原文
 * - 末尾已是 text → 拼接提示；否则新增 text 块
 */
export function appendTerminalErrorToBlocks<T extends TerminalErrorBlockLike>(
  blocks: readonly T[],
  error: string
): T[] {
  const notice = formatTerminalErrorNotice(error)
  const out: T[] = blocks.map((b) => {
    if (b.type === 'tool' && (b.status === 'running' || !b.status)) {
      return { ...b, status: 'error', result: error }
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
