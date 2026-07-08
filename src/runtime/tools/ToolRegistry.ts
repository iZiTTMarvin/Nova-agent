/**
 * ToolRegistry — 工具注册、发现与执行入口
 * 管理所有已注册工具，提供统一的查询和执行接口
 * 负责路径边界校验，确保工具不能访问工作区之外的文件
 */
import { resolve, relative, normalize, isAbsolute } from 'path'
import type { ToolDefinition } from '../model/types'
import type { ToolExecutor, ToolContext, ToolResult } from './types'

export type ResolveResult =
  | { ok: true; path: string }
  | { ok: false; error: string }

/**
 * 判断 resolved 是否落在 allowedRoot 之内（含根自身）。
 * 两侧先 normalize 再 relative，避免 Windows 盘符大小写 / 多余分隔符造成误判。
 *
 * 关键安全约束（Windows）：path.relative 在跨盘符时不会返回 `..\..`，而是直接返回
 * 目标的绝对路径（例如 `C:\secret`）。该结果不以 `..` 开头，若只做 startsWith('..')
 * 会把跨盘符路径误判为「在根内」。因此：relative 结果若是绝对路径 → 一律越界。
 */
function isPathWithinRoot(allowedRoot: string, resolved: string): boolean {
  const normalizedRoot = normalize(allowedRoot)
  const normalizedResolved = normalize(resolved)
  const rel = relative(normalizedRoot, normalizedResolved)
  // 完全相同（含 normalize 后等价）
  if (rel === '') return true
  // 跨盘符：relative 返回绝对路径 → 越界
  if (isAbsolute(rel)) return false
  // 同盘符但跳出根：rel 以 .. 开头
  return !rel.startsWith('..')
}

/**
 * 独立的路径解析与边界校验（不需要 ToolRegistry 实例）。
 * 工具执行时直接调用此函数，避免每次 new ToolRegistry() 的开销。
 *
 * @param extraAllowedRoots 可选的额外允许根目录（绝对路径）。
 *   设计决策：只给只读工具（read / ls / grep / find）传入；
 *   edit / write 不传 → skill 目录天然只读。
 *   理由：全局 skill 在 ~/.nova/skills/，给写权限意味着模型可以改写技能本身；
 *   builtin skill 在 asar 内本来就写不进去，行为还不一致。
 *   不传时行为与原先完全一致（现有调用方 / 测试零改动）。
 */
export function resolveAndValidatePath(
  workingDir: string,
  inputPath: string,
  extraAllowedRoots?: string[]
): ResolveResult {
  // 相对路径永远只基于 workingDir 解析，不会解析到 extraRoots 下
  const resolved = resolve(workingDir, inputPath)

  // 1) 工作区内 → 放行（与原先行为一致）
  if (isPathWithinRoot(workingDir, resolved)) {
    return { ok: true, path: resolved }
  }

  // 2) 额外只读根：任一根包含即可放行
  if (extraAllowedRoots && extraAllowedRoots.length > 0) {
    for (const root of extraAllowedRoots) {
      if (isPathWithinRoot(root, resolved)) {
        return { ok: true, path: resolved }
      }
    }
  }

  // 3) 全部不满足 → 原样返回越界错误（文案保持与原先一致）
  return { ok: false, error: `路径越界: "${inputPath}" 位于工作区 "${workingDir}" 之外` }
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

  /** 判断目标路径是否在工作区内（与 resolveAndValidatePath 同一套边界语义） */
  isWithinWorkspace(workingDir: string, inputPath: string): boolean {
    const resolved = resolve(workingDir, inputPath)
    return isPathWithinRoot(workingDir, resolved)
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
