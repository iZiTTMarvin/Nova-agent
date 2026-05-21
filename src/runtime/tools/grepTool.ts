/**
 * grepTool — 搜索文件内容
 * 在指定目录中递归搜索匹配关键字的行，限制在工作区内
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { ToolRegistry } from './ToolRegistry'
import type { ToolExecutor, ToolContext, ToolResult } from './types'

export const grepTool: ToolExecutor = {
  name: 'grep',
  description: '在工作区中递归搜索匹配指定模式的文件内容。返回匹配的文件名、行号和行内容。',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: '要搜索的文本模式（字面量匹配）'
      },
      path: {
        type: 'string',
        description: '搜索的起始目录，相对于工作区根目录。默认为工作区根目录。'
      }
    },
    required: ['pattern']
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const registry = new ToolRegistry()
    const pattern = args.pattern as string
    const inputPath = (args.path as string) || '.'

    if (!pattern) {
      return { success: false, output: '', error: '缺少 pattern 参数' }
    }

    const validated = registry.resolveAndValidate(context.workingDir, inputPath)
    if (!validated.ok) {
      return { success: false, output: '', error: validated.error }
    }

    const matches: string[] = []

    function searchDir(dir: string): void {
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }

      for (const entry of entries) {
        // 跳过 node_modules 和隐藏目录
        if (entry === 'node_modules' || entry.startsWith('.')) continue

        const fullPath = join(dir, entry)
        let stat
        try {
          stat = statSync(fullPath)
        } catch {
          continue
        }

        if (stat.isDirectory()) {
          searchDir(fullPath)
        } else if (stat.isFile()) {
          try {
            const content = readFileSync(fullPath, 'utf-8')
            const lines = content.split('\n')
            const rel = relative(context.workingDir, fullPath).replace(/\\/g, '/')

            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(pattern)) {
                matches.push(`${rel}:${i + 1}: ${lines[i]}`)
              }
            }
          } catch {
            // 跳过不可读文件（二进制等）
          }
        }
      }
    }

    searchDir(validated.path)

    if (matches.length === 0) {
      return { success: true, output: `未找到匹配 "${pattern}" 的内容` }
    }

    return { success: true, output: matches.join('\n') }
  }
}
