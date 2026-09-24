/**
 * 重试前保留已提交的工具轮次与持久运行时输入（含其前序 thinking/text）。
 * 丢掉末尾 running 工具与其后的临时 text/thinking，避免与下一 attempt 重复。
 * 主进程累积器与渲染层共用，避免两边对「可保留块」判断分叉。
 */

export type RetryRetainableBlock = {
  type: string
  status?: string
}

export function retainCommittedBlocksForRetry<T extends RetryRetainableBlock>(
  blocks: readonly T[]
): T[] {
  let lastCommittedBoundary = -1
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if ((b.type === 'tool' && b.status !== 'running') || b.type === 'runtime_input') {
      lastCommittedBoundary = i
    }
  }
  if (lastCommittedBoundary >= 0) {
    return blocks.slice(0, lastCommittedBoundary + 1)
  }
  return []
}
