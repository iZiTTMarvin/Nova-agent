/**
 * lsTool — 列出目录内容
 * 显示指定目录下的文件和子目录，限制在工作区内
 *
 * T2 异步化：readdirSync/statSync → readdir({withFileTypes}) + Dirent。
 * 单层列目录不接入 isPathSkipped 过滤——ls 应照常显示 target/ 这类目录条目
 * （让模型知道它存在），只是 ls 天然不递归，不会进入其内部。find 的递归遍历
 * 才用 isPathSkipped 排除构建产物。这是文档 T5.2 钉死的边界差异。
 */
import { readdir } from 'fs/promises'
import { join, relative } from 'path'
import { resolveAndValidatePath } from './ToolRegistry'
import { resolveToolArg } from './toolArgResolver'
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

      for (const entry of entries) {
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
      const body = lines.length === 0 ? '(空目录)' : lines.join('\n')
      return { success: true, output: `[workspace: ${context.workingDir}]\n${body}` }
    } catch (err) {
      return { success: false, output: '', error: `无法读取目录: ${(err as Error).message}` }
    }
  }
}
