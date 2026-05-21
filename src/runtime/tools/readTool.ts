/**
 * readTool — 读取文件内容
 * 读取指定文件的完整内容（文本），限制在工作区内
 */
import { readFileSync } from 'fs'
import { ToolRegistry } from './ToolRegistry'
import type { ToolExecutor, ToolContext, ToolResult } from './types'

export const readTool: ToolExecutor = {
  name: 'read',
  description: '读取指定文件的完整文本内容。用于查看源码、配置文件等。',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '要读取的文件路径，相对于工作区根目录。'
      }
    },
    required: ['path']
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const registry = new ToolRegistry()
    const inputPath = args.path as string

    if (!inputPath) {
      return { success: false, output: '', error: '缺少 path 参数' }
    }

    const validated = registry.resolveAndValidate(context.workingDir, inputPath)
    if (!validated.ok) {
      return { success: false, output: '', error: validated.error }
    }

    try {
      const content = readFileSync(validated.path, 'utf-8')
      return { success: true, output: content }
    } catch (err) {
      return { success: false, output: '', error: `无法读取文件: ${(err as Error).message}` }
    }
  }
}
