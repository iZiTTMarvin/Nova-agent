/**
 * 从一条开发助手回复的工具块中推导它确实改过的文件。
 * 主进程据此构造教学上下文，Renderer 据此决定是否提供「学懂这次改动」入口，两边必须同一实现。
 */

export const LEARNING_MAX_CHANGED_FILES = 20

/** 只依赖工具块的最小结构形状，持久化块与 Renderer 恢复块都满足。 */
export interface DevChangeBlockShape {
  readonly type: string
  readonly toolName?: string
  readonly arguments?: Record<string, unknown>
  readonly status?: string
}

function pathOf(block: DevChangeBlockShape): string | null {
  const args = block.arguments ?? {}
  const raw = block.toolName === 'edit' ? (args.filePath ?? args.path) : block.toolName === 'write' ? args.path : undefined
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

export function extractChangedFilePaths(blocks: readonly DevChangeBlockShape[] | undefined): string[] {
  const files: string[] = []
  for (const block of blocks ?? []) {
    if (block.type !== 'tool' || block.status !== 'success') continue
    const path = pathOf(block)
    if (!path || files.includes(path)) continue
    files.push(path)
    if (files.length >= LEARNING_MAX_CHANGED_FILES) break
  }
  return files
}
