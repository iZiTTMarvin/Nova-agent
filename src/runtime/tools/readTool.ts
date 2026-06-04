/**
 * readTool — 读取文件内容
 * 读取指定文件的完整内容（文本），限制在工作区内。
 * 读取后写入 ReadState，供 editTool 做先读后改安全校验。
 */
import { readFileSync, statSync } from 'fs'
import { ToolRegistry } from './ToolRegistry'
import type { ToolExecutor, ToolContext, ToolResult } from './types'
import { readState } from './editTool'
import { decodeFileBuffer } from './editDiff'

const UTF8_BOM = '\uFEFF'

function stripBomForRead(text: string): string {
  return text.startsWith(UTF8_BOM) ? text.slice(1) : text
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

export const readTool: ToolExecutor = {
  name: 'read',
  description: '读取指定文件的完整文本内容。用于查看源码、配置文件等。编辑文件前必须先读取。',
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
      const buf = readFileSync(validated.path)
      const { text } = decodeFileBuffer(buf)
      const stripped = stripBomForRead(text)
      const normalized = normalizeToLF(stripped)

      const stat = statSync(validated.path)
      readState.set(validated.path, {
        content: normalized,
        timestamp: stat.mtimeMs,
      })

      return { success: true, output: normalized }
    } catch (err) {
      return { success: false, output: '', error: `无法读取文件: ${(err as Error).message}` }
    }
  }
}
