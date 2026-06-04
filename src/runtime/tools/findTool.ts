/**
 * findTool — 按 glob 模式查找文件
 * 在工作区内递归搜索匹配指定 glob 模式的文件
 */
import { readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { resolveAndValidatePath } from './ToolRegistry'
import type { ToolExecutor, ToolContext, ToolResult } from './types'

/**
 * 简易 glob 匹配器
 * 支持 *（匹配非路径分隔符的任意字符）和 **（匹配任意路径段）
 */
function matchGlob(pattern: string, filePath: string): boolean {
  // 将 glob 模式转为正则
  let regex = ''
  let i = 0
  while (i < pattern.length) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        regex += '(?:.+/)?'
        i += 3
      } else {
        regex += '.*'
        i += 2
      }
    } else if (pattern[i] === '*') {
      regex += '[^/]*'
      i++
    } else if (pattern[i] === '?') {
      regex += '[^/]'
      i++
    } else if ('.+^${}()|[]\\'.includes(pattern[i])) {
      regex += '\\' + pattern[i]
      i++
    } else {
      regex += pattern[i]
      i++
    }
  }

  return new RegExp(`^${regex}$`).test(filePath)
}

export const findTool: ToolExecutor = {
  name: 'find',
  description: '按 glob 模式在工作区中查找文件。支持 * 和 ** 通配符。',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'glob 模式，例如 "**/*.ts"、"src/**/*.test.ts"'
      },
      path: {
        type: 'string',
        description: '搜索的起始目录，相对于工作区根目录。默认为工作区根目录。'
      }
    },
    required: ['pattern']
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const pattern = args.pattern as string
    const inputPath = (args.path as string) || '.'

    if (!pattern) {
      return { success: false, output: '', error: '缺少 pattern 参数' }
    }

    const validated = resolveAndValidatePath(context.workingDir, inputPath)
    if (!validated.ok) {
      return { success: false, output: '', error: validated.error }
    }

    const results: string[] = []
    // 搜索起点，glob 匹配基于此目录计算相对路径
    const searchRoot = validated.path

    function walkDir(dir: string): void {
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }

      for (const entry of entries) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue

        const fullPath = join(dir, entry)
        let stat
        try {
          stat = statSync(fullPath)
        } catch {
          continue
        }

        // glob 匹配基于搜索起点的相对路径
        const relToSearch = relative(searchRoot, fullPath).replace(/\\/g, '/')
        // 输出结果基于工作区根
        const relToWorkDir = relative(context.workingDir, fullPath).replace(/\\/g, '/')

        if (stat.isDirectory()) {
          walkDir(fullPath)
        } else if (stat.isFile()) {
          if (matchGlob(pattern, relToSearch)) {
            results.push(relToWorkDir)
          }
        }
      }
    }

    walkDir(validated.path)

    if (results.length === 0) {
      return { success: true, output: `未找到匹配 "${pattern}" 的文件` }
    }

    return { success: true, output: results.join('\n') }
  }
}
