/**
 * ToolRegistry — 工具注册、发现与执行入口
 * 管理所有已注册工具，提供统一的查询和执行接口
 * 负责路径边界校验，确保工具不能访问工作区之外的文件
 */
import { resolve, relative, normalize, sep } from 'path'
import type { ToolDefinition } from '../model/types'
import type { ToolExecutor, ToolContext, ToolResult } from './types'

export type ResolveResult =
  | { ok: true; path: string }
  | { ok: false; error: string }

/**
 * 独立的路径解析与边界校验（不需要 ToolRegistry 实例）。
 * 工具执行时直接调用此函数，避免每次 new ToolRegistry() 的开销。
 */
export function resolveAndValidatePath(workingDir: string, inputPath: string): ResolveResult {
  const resolved = resolve(workingDir, inputPath)
  const rel = relative(workingDir, normalize(resolved))
  if (rel.startsWith('..') || normalize(resolved).startsWith('..')) {
    return { ok: false, error: `路径越界: "${inputPath}" 位于工作区 "${workingDir}" 之外` }
  }
  return { ok: true, path: resolved }
}

export class ToolRegistry {
  private tools: Map<string, ToolExecutor> = new Map()

  /** 注册一个工具 */
  register(tool: ToolExecutor): void {
    this.tools.set(tool.name, tool)
  }

  /** 按名称获取工具，不存在返回 undefined */
  getTool(name: string): ToolExecutor | undefined {
    return this.tools.get(name)
  }

  /** 获取所有已注册工具的 schema 定义（用于传给模型） */
  getToolDefinitions(): ToolDefinition[] {
    const defs: ToolDefinition[] = []
    for (const tool of this.tools.values()) {
      defs.push({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      })
    }
    return defs
  }

  /** 执行指定工具，校验工具存在性 */
  async execute(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return { success: false, output: '', error: `工具 "${name}" 未注册` }
    }
    return tool.execute(args, context)
  }

  /** 将相对路径解析为绝对路径（不验证边界） */
  resolvePath(workingDir: string, inputPath: string): string {
    return resolve(workingDir, inputPath)
  }

  /** 判断目标路径是否在工作区内 */
  isWithinWorkspace(workingDir: string, inputPath: string): boolean {
    const normalizedWorkDir = normalize(workingDir) + sep
    const resolved = resolve(workingDir, inputPath)
    const normalizedResolved = normalize(resolved)

    // 通过 relative 判断：如果 resolved 在 workingDir 下，
    // relative 结果不会以 .. 开头
    const rel = relative(workingDir, normalizedResolved)
    return !rel.startsWith('..') && !normalize(resolved).startsWith('..')
  }

  /** 解析路径并验证工作区边界 */
  resolveAndValidate(workingDir: string, inputPath: string): ResolveResult {
    const resolved = resolve(workingDir, inputPath)
    if (!this.isWithinWorkspace(workingDir, inputPath)) {
      return { ok: false, error: `路径越界: "${inputPath}" 位于工作区 "${workingDir}" 之外` }
    }
    return { ok: true, path: resolved }
  }
}
