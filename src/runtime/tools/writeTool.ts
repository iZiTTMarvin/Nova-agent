/**
 * writeTool — 整文件写入或新建
 * 将指定内容写入文件，文件不存在则创建，存在则覆盖
 * 写入前通过 CheckpointManager 备份原始内容
 */
import { existsSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { ToolRegistry } from './ToolRegistry'
import type { ToolExecutor, ToolContext, ToolResult } from './types'

export const writeTool: ToolExecutor = {
  name: 'write',
  description:
    '创建新文件或完整覆写已有文件。' +
    '适用于创建新文件或需要完全重写文件内容的场景。' +
    '如果要修改文件中的部分内容，请使用 edit 工具。',
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
    const registry = new ToolRegistry()
    const inputPath = args.path as string
    const content = args.content as string

    if (!inputPath) {
      return { success: false, output: '', error: '缺少 path 参数' }
    }
    if (content === undefined || content === null) {
      return { success: false, output: '', error: '缺少 content 参数' }
    }

    const validated = registry.resolveAndValidate(context.workingDir, inputPath)
    if (!validated.ok) {
      return { success: false, output: '', error: validated.error }
    }

    const absolutePath = validated.path
    const isNewFile = !existsSync(absolutePath)

    // 写前备份
    if (context.checkpointManager) {
      context.checkpointManager.backupBeforeWrite(absolutePath, isNewFile)
    }

    // 写入文件
    try {
      mkdirSync(dirname(absolutePath), { recursive: true })
      writeFileSync(absolutePath, content, 'utf-8')
    } catch (err) {
      return { success: false, output: '', error: `写入文件失败: ${(err as Error).message}` }
    }

    return {
      success: true,
      output: isNewFile
        ? `已创建新文件 "${inputPath}"`
        : `已覆盖文件 "${inputPath}"`
    }
  }
}
