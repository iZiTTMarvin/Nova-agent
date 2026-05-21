/**
 * editTool — 精确修改已有文件
 * 通过 old/new 字符串替换来修改文件中的指定内容
 * 修改前通过 CheckpointManager 备份原始内容
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { ToolRegistry } from './ToolRegistry'
import type { ToolExecutor, ToolContext, ToolResult } from './types'

export const editTool: ToolExecutor = {
  name: 'edit',
  description:
    '精确修改已有文件。通过查找文件中的 old 字符串并替换为 new 字符串。' +
    '适用于修改代码中的特定片段。old 必须与文件中的内容精确匹配（包括缩进和换行）。',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '要修改的文件路径，相对于工作区根目录。'
      },
      old: {
        type: 'string',
        description: '要被替换的原始文本。必须与文件中的内容精确匹配。'
      },
      new: {
        type: 'string',
        description: '替换后的新文本。'
      }
    },
    required: ['path', 'old', 'new']
  },

  async execute(
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const registry = new ToolRegistry()
    const inputPath = args.path as string
    const oldText = args.old as string
    const newText = args.new as string

    if (!inputPath) {
      return { success: false, output: '', error: '缺少 path 参数' }
    }
    if (oldText === undefined || oldText === null) {
      return { success: false, output: '', error: '缺少 old 参数' }
    }
    if (newText === undefined || newText === null) {
      return { success: false, output: '', error: '缺少 new 参数' }
    }

    const validated = registry.resolveAndValidate(context.workingDir, inputPath)
    if (!validated.ok) {
      return { success: false, output: '', error: validated.error }
    }

    const absolutePath = validated.path

    // 读取原始内容
    let content: string
    try {
      content = readFileSync(absolutePath, 'utf-8')
    } catch (err) {
      return { success: false, output: '', error: `无法读取文件: ${(err as Error).message}` }
    }

    // 检查 old 是否存在于文件中
    if (!content.includes(oldText)) {
      return {
        success: false,
        output: '',
        error: `在文件中未找到要替换的文本。请确保 old 参数与文件内容精确匹配。`
      }
    }

    // 检查 old 是否在文件中出现多次（防止误操作）
    const occurrences = content.split(oldText).length - 1
    if (occurrences > 1) {
      return {
        success: false,
        output: '',
        error: `要替换的文本在文件中出现了 ${occurrences} 次，存在歧义。请提供更具体的上下文以唯一匹配。`
      }
    }

    // 写前备份
    if (context.checkpointManager) {
      context.checkpointManager.backupBeforeWrite(absolutePath, false)
    }


    // 执行替换
    const newContent = content.replace(oldText, newText)
    try {
      mkdirSync(dirname(absolutePath), { recursive: true })
      writeFileSync(absolutePath, newContent, 'utf-8')
    } catch (err) {
      return { success: false, output: '', error: `写入文件失败: ${(err as Error).message}` }
    }

    return {
      success: true,
      output: `已成功修改文件 "${inputPath}"，替换了 1 处文本。`
    }
  }
}
