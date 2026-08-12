/**
 * lsTool — 列出目录内容
 * 显示指定目录下的文件和子目录，限制在工作区内
 *
 * 异步化：readdirSync/statSync → readdir({withFileTypes}) + Dirent。
 * 单层列目录不接入 isPathSkipped 过滤——ls 应照常显示 target/ 这类目录条目
 * （让模型知道它存在），只是 ls 天然不递归，不会进入其内部。find 的递归遍历
 * 才用 isPathSkipped 排除构建产物。这是钉死的边界差异。
 */
import { readdir } from 'fs/promises'
import { join, relative } from 'path'
import { resolveAndValidatePath } from './ToolRegistry'
import { resolveToolArg } from './toolArgResolver'
import type { ToolExecutor, ToolContext, ToolResult } from './types'

/** 单层 ls 的最大展示条目数；超出只展示前 N 条并给出收窄建议，避免扁平大目录全量内联进上下文 */
export const LS_MAX_ENTRIES = 500

export const lsTool: ToolExecutor = {
  name: 'ls',
  description: '列出指定目录下的文件和子目录。返回目录条目列表，区分文件和目录。',
  executionMode: 'parallel',
  isConcurrencySafe: () => true,
  maxResultSizeChars: 100_000,
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
    const inputPath = resolveToolArg(args, 'path') ?? '.'

    // 第三参：本会话已触发的 skill 目录可作为额外只读根
    const validated = resolveAndValidatePath(context.workingDir, inputPath, context.extraAllowedRoots)
    if (!validated.ok) {
      return { success: false, output: '', error: validated.error }
    }

    try {
      // withFileTypes 返回 Dirent，可直接 isDirectory()，免去逐条 statSync 系统调用。
      // 异步 readdir 让出事件循环，即便目录条目极多也不会锁死主线程。
      const entries = await readdir(validated.path, { withFileTypes: true })
      const lines: string[] = []

      // 排序保证截断确定性：readdir 顺序不保证，不排序时「前 N 条」每次运行可能不同
      const sorted = entries.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
      for (const entry of sorted) {
        const rel = relative(context.workingDir, join(validated.path, entry.name)).replace(/\\/g, '/')
        //Dirent.isDirectory() 免 statSync；不可读条目（符号链接断裂等）走 catch 跳过
        try {
          lines.push(entry.isDirectory() ? `${rel}/` : rel)
        } catch {
          // 极少数 Dirent 判定异常，跳过该条目
        }
      }

      // 成功路径（含空目录）：在最前面加工作区绝对路径标头（session context 双保险），
      // 让模型即便不读 [Session context] 也能从工具结果拿到绝对路径锚点。
      // 失败 / 错误路径不加，避免污染错误诊断。
      if (lines.length === 0) {
        return { success: true, output: `[workspace: ${context.workingDir}]\n(空目录)` }
      }

      // 大目录控量：条目超过上限时只展示前 N 条并附收窄建议，与 find/grep 的大输出截断
      // 语义一致（条目级封顶 + maxResultSizeChars 字符级兜底）。totalBytes/totalLines
      // 按未截断的完整 body 计算，shownLines 为封顶后的展示条数。
      if (lines.length > LS_MAX_ENTRIES) {
        const fullBody = lines.join('\n')
        const body = `${lines.slice(0, LS_MAX_ENTRIES).join('\n')}\n...[共 ${lines.length} 个条目，已显示前 ${LS_MAX_ENTRIES} 个。目录过大，建议用 find 按 glob 模式（如 "src/**/*.ts"）或 grep 按内容缩小范围]`
        return {
          success: true,
          output: `[workspace: ${context.workingDir}]\n${body}`,
          truncationMeta: {
            totalBytes: Buffer.byteLength(fullBody, 'utf-8'),
            totalLines: lines.length,
            shownLines: LS_MAX_ENTRIES,
            truncated: true
          }
        }
      }

      return { success: true, output: `[workspace: ${context.workingDir}]\n${lines.join('\n')}` }
    } catch (err) {
      return { success: false, output: '', error: `无法读取目录: ${(err as Error).message}` }
    }
  }
}
