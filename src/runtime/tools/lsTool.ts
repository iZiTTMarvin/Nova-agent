/**
 * lsTool — 列出目录内容
 * 显示指定目录下的文件和子目录，限制在工作区内
 */
import { readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { resolveAndValidatePath } from './ToolRegistry'
import type { ToolExecutor, ToolContext, ToolResult } from './types'

export const lsTool: ToolExecutor = {
  name: 'ls',
  description: '列出指定目录下的文件和子目录。返回目录条目列表，区分文件和目录。',
  executionMode: 'parallel',
  isConcurrencySafe: () => true,
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '要列出的目录路径，相对于工作区根目录（绝对路径见 session context）。默认为当前目录。'
      }
    }
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const inputPath = (args.path as string) || '.'

    const validated = resolveAndValidatePath(context.workingDir, inputPath)
    if (!validated.ok) {
      return { success: false, output: '', error: validated.error }
    }

    try {
      const entries = readdirSync(validated.path)
      const lines: string[] = []

      for (const entry of entries) {
        const fullPath = join(validated.path, entry)
        try {
          const stat = statSync(fullPath)
          const rel = relative(context.workingDir, fullPath).replace(/\\/g, '/')
          lines.push(stat.isDirectory() ? `${rel}/` : rel)
        } catch {
          // 无权限等异常跳过
        }
      }

      // 成功路径（含空目录）：在最前面加工作区绝对路径标头（session context 双保险），
      // 让模型即便不读 [Session context] 也能从工具结果拿到绝对路径锚点。
      // 失败 / 错误路径不加，避免污染错误诊断。
      const body = lines.length === 0 ? '(空目录)' : lines.join('\n')
      return { success: true, output: `[workspace: ${context.workingDir}]\n${body}` }
    } catch (err) {
      return { success: false, output: '', error: `无法读取目录: ${(err as Error).message}` }
    }
  }
}
