/**
 * findTool — 按 glob 模式查找文件
 * 在工作区内递归搜索匹配指定 glob 模式的文件
 *
 * T3 异步化与加固（见 tasks/2026-06-25-只读工具异步化与构建产物排除治理.md）：
 * 1. readdirSync/statSync → readdir({withFileTypes}) 异步，每层 await 让出事件循环，
 *    即使误入大目录也只"慢"不"死"（防 Electron 主线程假死）。
 * 2. 排除清单接入 pathExclusions.BUILD_SKIP_DIRS，消除 target/ 等构建产物的同步遍历
 *    （本次卡死根因：Java/Maven 项目查找 .java 源码时会 statSync 掉 target/ 内数千文件）。
 * 3. matchGlob 的 new RegExp 提前到遍历前编译一次，避免每文件重复编译。
 * 4. 接入 context.abortSignal，用户取消时中断递归。
 * 5. 接入 createTruncationPipeline，海量匹配走截断（对齐 grep 品质）。
 * 6. 可选接入 .gitignore 解析（第 2 层排除）。
 */
import { readdir, stat } from 'fs/promises'
import { relative } from 'path'
import { resolveAndValidatePath } from './ToolRegistry'
import { resolveToolArg } from './toolArgResolver'
import { isPathSkipped, loadIgnoreMatcher } from './pathExclusions'
import { createTruncationPipeline } from './TruncationPipeline'
import type { ToolExecutor, ToolContext, ToolResult } from './types'

/**
 * 简易 glob 匹配器
 * 支持 *（匹配非路径分隔符的任意字符）和 **（匹配任意路径段）
 *
 * compileGlob 把 pattern 编译成 RegExp 一次，遍历循环内只 regex.test()，
 * 避免原实现每个文件 new RegExp 的重复编译开销（target/ 内数千文件时尤其明显）。
 */
function compileGlob(pattern: string): RegExp {
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

  return new RegExp(`^${regex}$`)
}

export const findTool: ToolExecutor = {
  name: 'find',
  description: '按 glob 模式在工作区中查找文件。支持 * 和 ** 通配符。',
  executionMode: 'parallel',
  isConcurrencySafe: () => true,
  maxResultSizeChars: 100_000,
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'glob 模式，例如 "**/*.ts"、"src/**/*.test.ts"'
      },
      path: {
        type: 'string',
        description: '搜索的起始目录，相对于工作区根目录（绝对路径见 session context）。默认为工作区根目录。'
      }
    },
    required: ['pattern']
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    // 参数名别名兼容：pattern 可能被模型写成 query / search / regex 等
    const pattern = resolveToolArg(args, 'pattern') ?? ''
    // path 不是必需参数（默认 '.'），但别名下也要能取到
    const inputPath = resolveToolArg(args, 'path') ?? '.'

    if (!pattern) {
      return { success: false, output: '', error: '缺少 pattern 参数' }
    }
    // 第三参：本会话已触发的 skill 目录可作为额外只读根
    const validated = resolveAndValidatePath(context.workingDir, inputPath, context.extraAllowedRoots)
    if (!validated.ok) {
      return { success: false, output: '', error: validated.error }
    }

    // 遍历前编译一次 glob（原实现每文件 new RegExp，是 target/ 内的无谓 CPU 开销）
    const globRegex = compileGlob(pattern)
    // 第 2 层：加载用户 .gitignore（fail-open，无文件则永不忽略）
    const ignoreMatcher = await loadIgnoreMatcher(context.workingDir)

    const results: string[] = []
    let cancelled = false
    // 搜索起点，glob 匹配基于此目录计算相对路径
    const searchRoot = validated.path

    /**
     * 异步递归遍历目录。
     *
     * 每层入口 + 每个 entry 处理前检查 abortSignal，命中即中断。
     * readdir 异步让出事件循环；withFileTypes 的 Dirent 可直接判类型，
     * 仅在确需区分文件/目录失败时才补一次 stat（符号链接等边缘情况）。
     */
    async function walkDir(dir: string): Promise<void> {
      if (context.abortSignal?.aborted) {
        cancelled = true
        return
      }

      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        if (context.abortSignal?.aborted) {
          cancelled = true
          return
        }

        const name = entry.name
        // 第 1 层：硬编码排除（构建产物 / 依赖 / 缓存 / 隐藏目录）
        if (isPathSkipped(name)) continue

        const fullPath = `${dir}/${entry.name}`
        // glob 匹配基于搜索起点的相对路径
        const relToSearch = relative(searchRoot, fullPath).replace(/\\/g, '/')
        // 输出结果基于工作区根
        const relToWorkDir = relative(context.workingDir, fullPath).replace(/\\/g, '/')

        let isDir: boolean
        try {
          // Dirent.isDirectory() 免 statSync；符号链接断裂等边缘情况补一次异步 stat
          isDir = entry.isDirectory()
        } catch {
          try {
            isDir = (await stat(fullPath)).isDirectory()
          } catch {
            continue
          }
        }

        if (isDir) {
          // 第 2 层：gitignore 过滤目录（命中即不递归进去）
          if (ignoreMatcher(relToWorkDir, true)) continue
          await walkDir(fullPath)
        } else {
          // 第 2 层：gitignore 过滤文件
          if (ignoreMatcher(relToWorkDir, false)) continue
          if (globRegex.test(relToSearch)) {
            results.push(relToWorkDir)
          }
        }
      }
    }

    await walkDir(validated.path)

    // 成功路径（含无匹配）：在工作区绝对路径标头后返回结果（session context 双保险）。
    let body: string
    let truncationMeta: ToolResult['truncationMeta']
    if (results.length === 0) {
      body = `未找到匹配 "${pattern}" 的文件`
    } else {
      const raw = results.join('\n')
      // 海量匹配走截断（对齐 grep），如 target/ 被误纳入时会触发
      const truncation = createTruncationPipeline().apply(raw)
      body = truncation.output
      if (truncation.truncated && truncation.meta) {
        body += `\n...[已截断，共 ${truncation.meta.total ?? results.length} 条，仅展示 ${truncation.meta.shown}]`
        truncationMeta = {
          totalBytes: Buffer.byteLength(raw, 'utf-8'),
          totalLines: results.length,
          shownLines: truncation.meta.shown,
          truncated: true
        }
      }
    }

    // 取消提示附加在末尾，不阻断已收集的部分结果
    if (cancelled) {
      body = results.length === 0
        ? `[操作已取消] ${body}`
        : `${body}\n...[操作已取消，结果可能不完整]`
    }

    return {
      success: true,
      output: `[workspace: ${context.workingDir}]\n${body}`,
      ...(truncationMeta ? { truncationMeta } : {})
    }
  }
}
