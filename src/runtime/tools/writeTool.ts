/**
 * writeTool — 整文件写入或新建
 * 将指定内容写入文件，文件不存在则创建，存在则覆盖
 * 写入前通过 CheckpointManager 备份原始内容
 * 支持 AbortSignal 取消、文件变更队列、可插拔的写入操作
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveAndValidatePath } from './ToolRegistry'
import { withFileMutationQueue } from './file-mutation-queue'
import type { ToolExecutor, ToolContext, ToolResult } from './types'

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations {
  /** Write content to a file */
  writeFile: (absolutePath: string, content: string) => Promise<void>
  /** Create directory recursively */
  mkdir: (dir: string) => Promise<void>
}

const defaultWriteOperations: WriteOperations = {
  writeFile: (path, content) => writeFile(path, content, 'utf-8'),
  mkdir: (dir) =>
    mkdir(dir, { recursive: true }).then(() => {})
}

export interface WriteToolOptions {
  /** Custom operations for file writing. Default: local filesystem */
  operations?: WriteOperations
}

/** 创建 write 工具执行器 */
export function createWriteTool(options?: WriteToolOptions): ToolExecutor {
  const ops = options?.operations ?? defaultWriteOperations

  return {
    name: 'write',
    description:
      '创建新文件或完整覆写已有文件。' +
      '适用于创建新文件或需要完全重写文件内容的场景。' +
      '如果要修改文件中的部分内容，请使用 edit 工具。',
    executionMode: 'sequential',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '要写入的文件路径，相对于工作区根目录。'
        },
        content: {
          type: 'string',
          description: '要写入文件的完整内容。'
        }
      },
      required: ['path', 'content']
    },

    async execute(
      args: Record<string, unknown>,
      context: ToolContext
    ): Promise<ToolResult> {
      const inputPath = args.path as string
      const content = args.content as string

      if (!inputPath) {
        return { success: false, output: '', error: '缺少 path 参数' }
      }
      if (content === undefined || content === null) {
        return { success: false, output: '', error: '缺少 content 参数' }
      }

      const validated = resolveAndValidatePath(context.workingDir, inputPath)
      if (!validated.ok) {
        return { success: false, output: '', error: validated.error }
      }

      const absolutePath = validated.path
      const dir = dirname(absolutePath)

      return withFileMutationQueue(absolutePath, async () => {
        // 推迟拒绝：不在 abort 事件监听器中拒绝，避免在文件系统操作
        // 仍在进行时释放变更队列。在每个 await 后检查 signal.aborted
        // 可以达到同样的取消效果，同时保持队列锁定直到当前操作完成。
        const throwIfAborted = (): void => {
          if (context.abortSignal?.aborted) {
            throw new Error('操作已取消')
          }
        }

        throwIfAborted()

        // 在队列内判断是否为新文件并备份，避免并发写入时的竞态
        const isNewFile = !existsSync(absolutePath)
        if (context.checkpointManager) {
          context.checkpointManager.backupBeforeWrite(absolutePath, isNewFile)
        }

        // 创建父目录（如需要）
        await ops.mkdir(dir)
        throwIfAborted()

        // 写入文件内容
        await ops.writeFile(absolutePath, content)
        throwIfAborted()

        return {
          success: true,
          output: isNewFile
            ? `已创建新文件 "${inputPath}"`
            : `已覆盖文件 "${inputPath}"`
        }
      }).catch((err) => {
        // withFileMutationQueue 在 fn reject 或 abort 后会 throw，
        // 统一转换为 ToolResult 错误形式
        if (err instanceof Error) {
          return {
            success: false,
            output: '',
            error: `写入文件失败: ${err.message}`
          }
        }
        throw err
      })
    }
  }
}

/** 默认 write 工具实例（使用本地文件系统） */
export const writeTool: ToolExecutor = createWriteTool()
