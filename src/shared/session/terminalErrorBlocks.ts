/**
 * 终态错误并入消息 blocks：主进程落盘与渲染层 UI 共用，避免文案/标错逻辑分叉。
 */
export const TERMINAL_ERROR_NOTICE_PREFIX = '⚠️ '

/** 生成终态错误提示文案（含统一前缀） */
export function formatTerminalErrorNotice(error: string): string {
  return `${TERMINAL_ERROR_NOTICE_PREFIX}${error}`
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
