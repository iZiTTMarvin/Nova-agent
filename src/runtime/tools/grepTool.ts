import { spawn } from 'child_process'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { createInterface } from 'readline'
import { resolveAndValidatePath } from './ToolRegistry'
import { findRipgrep, isRgAvailable } from './find-rg'
import { createTruncationPipeline } from './TruncationPipeline'
import type { ToolExecutor, ToolContext, ToolResult } from './types'
import type { GrepInput, GrepOutputMode, GrepToolOptions } from './grep-types'

const REGEX_META_CHARS = /[.*+?[\](){}|^$\\]/

function buildDescription(rgReady: boolean): string {
  const base = '在工作区中递归搜索匹配指定模式的文件内容。'

  if (!rgReady) {
    return base + '支持字面量匹配，返回文件路径、行号和匹配内容。'
  }

  return base + `

参数说明：
- pattern: 搜索模式（自动检测是否为正则，不含元字符时用字面量匹配）
- path: 搜索起始目录，默认为工作区根目录
- output_mode: 输出格式
  - "content"（默认）: 返回 文件:行号: 内容
  - "files_with_matches": 仅返回包含匹配的文件路径
  - "count": 返回每个文件的匹配数
- glob: 文件过滤模式，如 "*.ts" 只搜索 TypeScript 文件
- type: ripgrep 内置文件类型，如 "ts", "js", "py"
- -A / -B / -C: 匹配行后/前/前后上下文行数
- head_limit: 限制返回的匹配条数（按逻辑匹配计数，非输出行数；用于分页）
- offset: 跳过前 N 条匹配（按逻辑匹配计数；配合 head_limit 分页）
- multiline: 启用多行正则匹配

使用场景：
1. 快速定位代码：pattern: "functionName", glob: "*.ts"
2. 了解影响范围：output_mode: "files_with_matches", pattern: "import.*module"
3. 统计匹配数：output_mode: "count", pattern: "TODO"`
}

export function createGrepTool(options?: Partial<GrepToolOptions>): ToolExecutor {
  const maxResultSizeChars = options?.maxResultSizeChars ?? 100_000

  return {
    name: 'grep',
    description: buildDescription(isRgAvailable()),
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: '搜索模式（自动检测正则）'
        },
        path: {
          type: 'string',
          description: '搜索起始目录，默认为工作区根目录'
        },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description: '输出格式：content（默认）、files_with_matches、count'
        },
        glob: {
          type: 'string',
          description: '文件过滤 glob 模式，如 "*.ts"'
        },
        type: {
          type: 'string',
          description: 'ripgrep 内置文件类型，如 "ts", "js"'
        },
        '-A': {
          type: 'number',
          description: '匹配行后的上下文行数'
        },
        '-B': {
          type: 'number',
          description: '匹配行前的上下文行数'
        },
        '-C': {
          type: 'number',
          description: '匹配行前后的上下文行数'
        },
        head_limit: {
          type: 'number',
          description: '限制返回的匹配条数（按逻辑匹配计数，非输出行数）'
        },
        offset: {
          type: 'number',
          description: '跳过前 N 条匹配（按逻辑匹配计数，配合 head_limit 分页）'
        },
        multiline: {
          type: 'boolean',
          description: '启用多行正则匹配'
        }
      },
      required: ['pattern']
    },
    maxResultSizeChars,

    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const input = args as unknown as GrepInput
      const pattern = input.pattern
      const inputPath = input.path ?? '.'
      const outputMode: GrepOutputMode = input.output_mode ?? 'content'
      const glob = input.glob
      const type = input.type
      const afterContext = input['-A']
      const beforeContext = input['-B']
      const contextLines = input['-C']
      const headLimit = input.head_limit
      const offset = input.offset
      const multiline = input.multiline

      if (!pattern) {
        return { success: false, output: '', error: '缺少 pattern 参数' }
      }

      const validated = resolveAndValidatePath(context.workingDir, inputPath)
      if (!validated.ok) {
        return { success: false, output: '', error: validated.error }
      }

      if (isRgAvailable()) {
        return executeWithRipgrep(
          pattern,
          validated.path,
          context,
          outputMode,
          glob,
          type,
          afterContext,
          beforeContext,
          contextLines,
          headLimit,
          offset,
          multiline
        )
      }

      return executeFallback(
        pattern,
        validated.path,
        context,
        outputMode,
        headLimit,
        offset
      )
    }
  }
}

async function executeWithRipgrep(
  pattern: string,
  searchPath: string,
  context: ToolContext,
  outputMode: GrepOutputMode,
  glob: string | undefined,
  type: string | undefined,
  afterContext: number | undefined,
  beforeContext: number | undefined,
  contextLines: number | undefined,
  headLimit: number | undefined,
  offset: number | undefined,
  multiline: boolean | undefined
): Promise<ToolResult> {
  const rgPath = findRipgrep()
  const rgArgs: string[] = [
    '--json',
    '--no-heading',
    '--with-filename',
    '--line-number',
    '--ignore-case'
  ]

  if (outputMode === 'files_with_matches') {
    rgArgs.push('-l')
  } else if (outputMode === 'count') {
    rgArgs.push('--count')
  }

  if (glob) {
    rgArgs.push('--glob', glob)
  }

  if (type) {
    rgArgs.push('--type', type)
  }

  if (afterContext != null) {
    rgArgs.push('-A', String(afterContext))
  }

  if (beforeContext != null) {
    rgArgs.push('-B', String(beforeContext))
  }

  if (contextLines != null) {
    rgArgs.push('-C', String(contextLines))
  }

  if (multiline) {
    rgArgs.push('--multiline')
  }

  if (!REGEX_META_CHARS.test(pattern)) {
    rgArgs.push('--fixed-strings')
  }

  rgArgs.push(pattern, searchPath)

  return new Promise((resolve) => {
    const rgProcess = spawn(rgPath, rgArgs, { stdio: ['ignore', 'pipe', 'pipe'] })

    if (context.abortSignal) {
      context.abortSignal.addEventListener('abort', () => {
        rgProcess.kill()
      })
    }

    const rl = createInterface({ input: rgProcess.stdout })
    const results: string[] = []
    const fileMatches = new Map<string, number>()
    let matchCount = 0
    let skipped = 0

    rl.on('line', (line) => {
      try {
        const event = JSON.parse(line)

        if (event.type === 'match') {
          const data = event.data
          const filePath = data.path?.text ?? ''
          const relPath = relative(context.workingDir, filePath).replace(/\\/g, '/')
          const lineNumber = data.line_number
          const linesText = data.lines?.text ?? ''

          if (outputMode === 'files_with_matches') {
            if (!fileMatches.has(relPath)) {
              fileMatches.set(relPath, 1)
              matchCount++
            }
          } else if (outputMode === 'count') {
            fileMatches.set(relPath, (fileMatches.get(relPath) ?? 0) + 1)
          } else {
            if (offset != null && skipped < offset) {
              skipped++
              return
            }

            if (headLimit != null && matchCount >= headLimit) {
              rgProcess.kill()
              return
            }

            matchCount++
            const lines = linesText.split('\n').filter((l: string) => l.length > 0)
            for (const contentLine of lines) {
              results.push(`${relPath}:${lineNumber}: ${contentLine}`)
            }
          }
        } else if (event.type === 'summary') {
          // summary 事件包含总计信息，可用于验证
        }
      } catch {
        // JSON 解析失败，跳过该行
      }
    })

    rgProcess.on('close', (code) => {
      rl.close()

      if (outputMode === 'files_with_matches') {
        const files = Array.from(fileMatches.keys())
        if (files.length === 0) {
          resolve({ success: true, output: `未找到匹配 "${pattern}" 的内容` })
        } else {
          resolve({ success: true, output: files.join('\n') })
        }
      } else if (outputMode === 'count') {
        if (fileMatches.size === 0) {
          resolve({ success: true, output: `未找到匹配 "${pattern}" 的内容` })
        } else {
          const lines: string[] = []
          for (const [file, count] of fileMatches) {
            lines.push(`${file}: ${count}`)
          }
          resolve({ success: true, output: lines.join('\n') })
        }
      } else {
        if (results.length === 0) {
          if (code === 1) {
            resolve({ success: true, output: `未找到匹配 "${pattern}" 的内容` })
          } else if (code === 2) {
            resolve({ success: false, output: '', error: 'ripgrep 执行出错' })
          } else {
            resolve({ success: true, output: `未找到匹配 "${pattern}" 的内容` })
          }
        } else {
          resolve({ success: true, output: results.join('\n') })
        }
      }
    })

    rgProcess.on('error', (err) => {
      rl.close()
      resolve({ success: false, output: '', error: `ripgrep 启动失败: ${err.message}` })
    })
  })
}

async function executeFallback(
  pattern: string,
  searchPath: string,
  context: ToolContext,
  outputMode: GrepOutputMode,
  headLimit: number | undefined,
  offset: number | undefined
): Promise<ToolResult> {
  const matches: string[] = []
  const fileMatches = new Map<string, number>()
  let matchCount = 0
  let skipped = 0

  function searchDir(dir: string): void {
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

      if (stat.isDirectory()) {
        searchDir(fullPath)
      } else if (stat.isFile()) {
        try {
          const content = readFileSync(fullPath, 'utf-8')
          const lines = content.split('\n')
          const rel = relative(context.workingDir, fullPath).replace(/\\/g, '/')

          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(pattern)) {
              if (outputMode === 'files_with_matches') {
                if (!fileMatches.has(rel)) {
                  fileMatches.set(rel, 1)
                  matchCount++
                }
              } else if (outputMode === 'count') {
                fileMatches.set(rel, (fileMatches.get(rel) ?? 0) + 1)
              } else {
                if (offset != null && skipped < offset) {
                  skipped++
                  continue
                }

                if (headLimit != null && matchCount >= headLimit) {
                  return
                }

                matches.push(`${rel}:${i + 1}: ${lines[i]}`)
                matchCount++
              }
            }
          }
        } catch {
          // 忽略不可读文件
        }
      }
    }
  }

  searchDir(searchPath)

  if (outputMode === 'files_with_matches') {
    const files = Array.from(fileMatches.keys())
    if (files.length === 0) {
      return { success: true, output: `未找到匹配 "${pattern}" 的内容` }
    }
    return { success: true, output: files.join('\n') }
  }

  if (outputMode === 'count') {
    if (fileMatches.size === 0) {
      return { success: true, output: `未找到匹配 "${pattern}" 的内容` }
    }
    const lines: string[] = []
    for (const [file, count] of fileMatches) {
      lines.push(`${file}: ${count}`)
    }
    return { success: true, output: lines.join('\n') }
  }

  if (matches.length === 0) {
    return { success: true, output: `未找到匹配 "${pattern}" 的内容` }
  }

  const pipeline = createTruncationPipeline()
  const result = pipeline.apply(matches.join('\n'))
  return { success: true, output: result.output }
}
