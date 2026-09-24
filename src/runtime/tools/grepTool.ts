import { spawn } from 'child_process'
import { open, readdir } from 'fs/promises'
import { join, relative } from 'path'
import { createInterface } from 'readline'
import { resolveAndValidateToolPath } from './ToolRegistry'
import {
  createCanonicalPathCache,
  canonicalizeTargetPath,
  isPathAccessible,
  type CanonicalPathCache
} from '../permissions/pathAccess'
import { findRipgrep, isRgAvailable } from './find-rg'
import { createTruncationPipeline } from './TruncationPipeline'
import { OutputSink } from './OutputSink'
import type { ToolExecutor, ToolContext, ToolResult } from './types'
import { resolveToolArg } from './toolArgResolver'
import type { GrepInput, GrepOutputMode, GrepToolOptions } from './grep-types'
// 目录排除清单与 gitignore 解析统一走共享模块，消除与 findTool 的重复。
import { isPathSkipped, loadIgnoreMatcher, type IgnoreMatcher } from '../workspace'

// picomatch 仅用于 glob 参数匹配（GlobMatcher）；gitignore 解析已移至 pathExclusions。
// @ts-expect-error - picomatch is a transitive dep without @types/picomatch
import picomatch from 'picomatch'

const REGEX_META_CHARS = /[.*+?[\](){}|^$\\]/

// 回退路径共享的早停/统计状态。跨 searchDir/grepFile 递归传递。
interface FallbackState {
  cancelled: boolean
  matchCount: number
  skipped: number
  matches: FallbackMatch[]
  fileMatches: Map<string, number>
  headLimitReached: boolean
}

interface FallbackMatch {
  file: string
  line: number
  text: string
}

type GlobMatcher = (relPath: string) => boolean

interface SearchOptions {
  pattern: string
  signal: AbortSignal | undefined
  globMatcher: GlobMatcher | null
  ignoreMatcher: IgnoreMatcher
  beforeN: number
  afterN: number
  workingDir: string
  workspaceRoot: string
  sessionId?: string
  toolCallId?: string
  cache?: CanonicalPathCache
  headLimit: number | undefined
  offset: number | undefined
  outputMode: GrepOutputMode
}

function buildDescription(rgReady: boolean): string {
  const base = 'Recursively search file contents across the workspace for matches of a pattern.'

  if (!rgReady) {
    return base + 'Supports literal matching and returns file paths, line numbers, and matching content.'
  }

  return base + `

Parameters:
- pattern: search pattern (auto-detected as regex; literal matching when it contains no metacharacters)
- path: search root directory; defaults to the workspace root (absolute paths appear in session context)
- output_mode: output format
  - "content" (default): returns file:line: content
  - "files_with_matches": returns only the paths of files containing matches
  - "count": returns the match count per file
- glob: file filter pattern, e.g. "*.ts" to search only TypeScript files
- type: ripgrep built-in file type, e.g. "ts", "js", "py"
- -A / -B / -C: number of context lines after / before / around a match
- head_limit: caps the number of returned matches (counted as logical matches, not output lines; for pagination)
- offset: skips the first N matches (counted as logical matches; with head_limit for pagination)
- multiline: enables multiline regex matching

Use cases:
1. Quick code lookup: pattern: "functionName", glob: "*.ts"
2. Understand the blast radius: output_mode: "files_with_matches", pattern: "import.*module"
3. Count matches: output_mode: "count", pattern: "TODO"`
}

export function createGrepTool(options?: Partial<GrepToolOptions>): ToolExecutor {
  const maxResultSizeChars = options?.maxResultSizeChars ?? 100_000

  return {
    name: 'grep',
    description: buildDescription(isRgAvailable()),
    executionMode: 'parallel',
    isConcurrencySafe: () => true,
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Search pattern (regex auto-detected)'
        },
        path: {
          type: 'string',
          description: 'Search root directory; defaults to the workspace root (absolute paths appear in session context)'
        },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description: 'Output format: content (default), files_with_matches, count'
        },
        glob: {
          type: 'string',
          description: 'Glob file filter, e.g. "*.ts"'
        },
        type: {
          type: 'string',
          description: 'Ripgrep built-in file type, e.g. "ts", "js"'
        },
        '-A': {
          type: 'number',
          description: 'Context lines after a match'
        },
        '-B': {
          type: 'number',
          description: 'Context lines before a match'
        },
        '-C': {
          type: 'number',
          description: 'Context lines around a match'
        },
        head_limit: {
          type: 'number',
          description: 'Caps the number of returned matches (counted as logical matches, not output lines)'
        },
        offset: {
          type: 'number',
          description: 'Skips the first N matches (counted as logical matches; with head_limit for pagination)'
        },
        multiline: {
          type: 'boolean',
          description: 'Enable multiline regex matching'
        }
      },
      required: ['pattern']
    },
    maxResultSizeChars,

    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const input = args as unknown as GrepInput
      // 参数名别名兼容：pattern 可能被模型写成 query / search / regex；
      // path 可能被写成 filePath / file_path 等
      const pattern = resolveToolArg(args, 'pattern') ?? input.pattern
      const inputPath = resolveToolArg(args, 'path') ?? input.path ?? '.'
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

      const cache = createCanonicalPathCache()
      const validated = resolveAndValidateToolPath(context, inputPath, 'read', cache)
      if (!validated.ok) {
        return { success: false, output: '', error: validated.error }
      }

      let result: ToolResult
      let fallbackPrefix = ''

      if (isRgAvailable()) {
        result = await executeWithRipgrep(
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
          multiline,
          cache
        )
      } else {
        const fallback = await executeFallback(
          pattern,
          validated.path,
          context,
          outputMode,
          glob,
          afterContext,
          beforeContext,
          contextLines,
          headLimit,
          offset,
          cache
        )
        result = fallback.result
        fallbackPrefix = fallback.prefix
      }

      // content 模式大输出走 OutputSink；files_with_matches / count 保持原样
      result = await finalizeGrepOutput(result, context, outputMode)

      // 回退模式警告在 OutputSink 之后拼接，避免进入 artifact 正文
      if (fallbackPrefix) {
        result = {
          ...result,
          output: `${fallbackPrefix}${result.output ?? ''}`
        }
      }

      return prefixWorkspaceHeader(result, context.workingDir)
    }
  }
}

/**
 * 在 grep 成功结果前加工作区绝对路径标头（session context 双保险）。
 *
 * 判断规则（v2 修正）：
 * - success:true 且无 error → 加标头（含无匹配、"未找到"等所有成功路径）
 * - success:false 或有 error → 不加（避免污染错误诊断）
 *
 * 上一版用 startsWith('未找到匹配') 判断是错误的：fallback 路径会先拼 [回退模式...]
 * warning，导致 output 永远不以"未找到匹配"开头，所有 fallback 无匹配结果都被误加标头。
 */
function prefixWorkspaceHeader(result: ToolResult, workingDir: string): ToolResult {
  if (!result.success || result.error) return result
  return { ...result, output: `[workspace: ${workingDir}]\n${result.output ?? ''}` }
}

/**
 * content 模式大输出统一走 OutputSink 二次控量。
 * files_with_matches / count 或缺少 artifactStore 时原样返回。
 */
async function finalizeGrepOutput(
  result: ToolResult,
  context: ToolContext,
  outputMode: GrepOutputMode
): Promise<ToolResult> {
  if (
    !result.success ||
    result.error ||
    outputMode !== 'content' ||
    !context.artifactStore ||
    !context.sessionId
  ) {
    return result
  }

  const sink = new OutputSink({
    artifactStore: context.artifactStore,
    sessionId: context.sessionId,
    toolName: 'grep'
  })
  const finalized = await sink.finalize(result.output ?? '')

  return {
    ...result,
    output: finalized.contextText,
    ...(finalized.artifactId ? { artifactId: finalized.artifactId } : {}),
    ...(finalized.truncationMeta?.truncated
      ? { truncationMeta: finalized.truncationMeta }
      : {})
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
  multiline: boolean | undefined,
  cache: CanonicalPathCache
): Promise<ToolResult> {
  const rgPath = findRipgrep()
  const workspaceCanon = canonicalizeTargetPath(context.workingDir)
  const relativeRoot = workspaceCanon.ok ? workspaceCanon.path : context.workingDir
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
          if (
            !filePath ||
            !isPathAccessible({
              workingDir: context.workingDir,
              inputPath: filePath,
              access: 'read',
              sessionId: context.sessionId,
              toolCallId: context.invocationRef?.toolCallId,
              cache
            })
          ) {
            return
          }
          const relPath = relative(relativeRoot, filePath).replace(/\\/g, '/')
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
  glob: string | undefined,
  afterContext: number | undefined,
  beforeContext: number | undefined,
  contextLines: number | undefined,
  headLimit: number | undefined,
  offset: number | undefined,
  cache: CanonicalPathCache
): Promise<{ result: ToolResult; prefix: string }> {
  const state: FallbackState = {
    cancelled: false,
    matchCount: 0,
    skipped: 0,
    matches: [],
    fileMatches: new Map(),
    headLimitReached: false
  }

  // -C 优先于 -A/-B（与 ripgrep 行为一致）
  const beforeN = contextLines ?? beforeContext ?? 0
  const afterN = contextLines ?? afterContext ?? 0

  const globMatcher: GlobMatcher | null = glob
    ? (relPath) => picomatch.isMatch(relPath, glob, { dot: true })
    : null
  const ignoreMatcher = await loadIgnoreMatcher(context.workingDir)

  // 监听 abort 信号，触发时立即终止整个遍历。
  // { once: true } 让一次性触发后自动解绑，避免泄漏。
  const onAbort = () => {
    state.cancelled = true
  }
  if (context.abortSignal) {
    if (context.abortSignal.aborted) {
      state.cancelled = true
    } else {
      context.abortSignal.addEventListener('abort', onAbort, { once: true })
    }
  }

  const workspaceCanon = canonicalizeTargetPath(context.workingDir)
  const opts: SearchOptions = {
    pattern,
    signal: context.abortSignal,
    globMatcher,
    ignoreMatcher,
    beforeN,
    afterN,
    workingDir: workspaceCanon.ok ? workspaceCanon.path : context.workingDir,
    workspaceRoot: context.workingDir,
    sessionId: context.sessionId,
    toolCallId: context.invocationRef?.toolCallId,
    cache,
    headLimit,
    offset,
    outputMode
  }

  try {
    await searchDir(searchPath, state, opts)
  } finally {
    if (context.abortSignal) {
      context.abortSignal.removeEventListener('abort', onAbort)
    }
  }

  // 格式化输出
  let output: string
  if (outputMode === 'files_with_matches') {
    const files = Array.from(state.fileMatches.keys())
    output = files.length === 0 ? `未找到匹配 "${pattern}" 的内容` : files.join('\n')
  } else if (outputMode === 'count') {
    if (state.fileMatches.size === 0) {
      output = `未找到匹配 "${pattern}" 的内容`
    } else {
      const lines: string[] = []
      for (const [file, count] of state.fileMatches) {
        lines.push(`${file}: ${count}`)
      }
      output = lines.join('\n')
    }
  } else {
    if (state.matches.length === 0) {
      output = `未找到匹配 "${pattern}" 的内容`
    } else {
      const raw = state.matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join('\n')
      // 有 artifactStore 时交给 OutputSink 统一控量；否则走旧 TruncationPipeline 兜底
      if (context.artifactStore && context.sessionId) {
        output = raw
      } else {
        const pipeline = createTruncationPipeline()
        output = pipeline.apply(raw).output
      }
    }
  }

  // 回退模式警告在 OutputSink 之后由 execute() 拼接，此处只生成前缀文本
  const warnings: string[] = ['[回退模式: 性能可能较慢，建议安装 ripgrep]']
  if (state.headLimitReached) {
    warnings.push('[已达 head_limit 上限，结果可能不完整]')
  } else if (state.cancelled) {
    warnings.push('[操作已取消，结果可能不完整]')
  }
  const prefix = `${warnings.join('\n')}\n`

  return { result: { success: true, output }, prefix }
}

/**
 * 异步递归遍历目录。在每层入口和每个 entry 处理前检查 state.cancelled，
 * 配合 grepFile 的 onLine 回调返回 false 实现真正的 head_limit 早停。
 */
async function searchDir(dir: string, state: FallbackState, opts: SearchOptions): Promise<void> {
  if (state.cancelled) return

  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    // 目录不可读（权限、消失等）→ 静默跳过
    return
  }

  for (const entry of entries) {
    if (state.cancelled) return

    const name = entry.name
    // 硬编码排除优先于 .gitignore：避免某些仓库 .gitignore 缺失时污染结果。
    // isPathSkipped 合并了"隐藏目录(.开头)"与"BUILD_SKIP_DIRS"两层判断，
    // 与 findTool 保持一致的排除语义。
    if (isPathSkipped(name)) continue

    const fullPath = join(dir, name)
    if (
      !isPathAccessible({
        workingDir: opts.workspaceRoot,
        inputPath: fullPath,
        access: 'read',
        sessionId: opts.sessionId,
        toolCallId: opts.toolCallId,
        cache: opts.cache
      })
    ) {
      continue
    }
    const relPath = relative(opts.workingDir, fullPath).replace(/\\/g, '/')

    if (entry.isDirectory()) {
      if (opts.ignoreMatcher(relPath, true)) continue
      await searchDir(fullPath, state, opts)
    } else if (entry.isFile()) {
      if (opts.ignoreMatcher(relPath, false)) continue
      if (opts.globMatcher && !opts.globMatcher(relPath)) continue
      await grepFile(fullPath, relPath, state, opts)
    }
    // symlink / 其它类型 → 跳过，避免循环
  }
}

/**
 * 流式读取单个文件：先做二进制检测，再逐行消费 readline。
 *
 * 设计要点：
 * - 读取前 512 字节检测 \0 判定为二进制，跳过整个文件
 * - 通过 state.cancelled 共享标志实现 abort/head_limit 早停
 * - onLine 风格的处理：找到匹配时直接 push 到 state.matches
 * - 维护 preBuffer 环形缓冲实现 beforeContext，postCounter 倒计时实现 afterContext
 * - 文件句柄在 finish() 中统一关闭，避免 fd 泄漏
 */
async function grepFile(
  fullPath: string,
  relPath: string,
  state: FallbackState,
  opts: SearchOptions
): Promise<void> {
  if (state.cancelled) return

  // 1. 二进制检测：读前 512 字节，命中 \0 即视为二进制
  let fileHandle
  try {
    fileHandle = await open(fullPath, 'r')
    const buffer = Buffer.alloc(512)
    const { bytesRead } = await fileHandle.read(buffer, 0, 512, 0)
    if (buffer.subarray(0, bytesRead).includes(0)) {
      await fileHandle.close()
      return
    }
  } catch {
    if (fileHandle) {
      try { await fileHandle.close() } catch { /* ignore */ }
    }
    return
  }

  // 2. 流式逐行读取
  const stream = fileHandle.createReadStream()
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  // 上下文行状态（每个文件独立，重置）
  const preBuffer: FallbackMatch[] = []
  let postCounter = 0
  let lineNumber = 0

  const closeAll = () => {
    rl.close()
    stream.destroy()
  }

  return new Promise<void>((resolve) => {
    let resolved = false
    const finish = () => {
      if (resolved) return
      resolved = true
      try { fileHandle.close() } catch { /* ignore */ }
      resolve()
    }

    rl.on('line', (line: string) => {
      if (state.cancelled) {
        closeAll()
        return
      }

      lineNumber++
      const info: FallbackMatch = { file: relPath, line: lineNumber, text: line }

      // afterContext 倒计时：先把当前行作为"匹配后内容"输出
      if (postCounter > 0) {
        if (opts.outputMode === 'content') {
          state.matches.push(info)
        }
        postCounter--
        // 仍然更新 preBuffer：下一个匹配可能用到这些行
        preBuffer.push(info)
        if (preBuffer.length > opts.beforeN) preBuffer.shift()
        return
      }

      const isMatch = line.includes(opts.pattern)
      if (!isMatch) {
        preBuffer.push(info)
        if (preBuffer.length > opts.beforeN) preBuffer.shift()
        return
      }

      // 匹配命中

      // offset 仅对 content 模式生效（与 ripgrep 路径保持一致）
      if (opts.outputMode === 'content' && opts.offset != null && state.skipped < opts.offset) {
        state.skipped++
        return
      }

      // headLimit 仅对 content 模式生效
      if (opts.outputMode === 'content' && opts.headLimit != null && state.matchCount >= opts.headLimit) {
        state.cancelled = true
        state.headLimitReached = true
        closeAll()
        return
      }

      // 输出 beforeContext（preBuffer 中所有"前 N 行"）
      if (opts.outputMode === 'content' && preBuffer.length > 0) {
        for (const ctx of preBuffer) {
          state.matches.push(ctx)
        }
      }
      preBuffer.length = 0

      // 输出当前匹配
      if (opts.outputMode === 'files_with_matches') {
        if (!state.fileMatches.has(relPath)) {
          state.fileMatches.set(relPath, 1)
          state.matchCount++
        }
      } else if (opts.outputMode === 'count') {
        state.fileMatches.set(relPath, (state.fileMatches.get(relPath) ?? 0) + 1)
      } else {
        state.matches.push(info)
        state.matchCount++
      }

      postCounter = opts.afterN
    })

    rl.on('close', finish)
    stream.on('error', () => {
      closeAll()
      finish()
    })
  })
}
