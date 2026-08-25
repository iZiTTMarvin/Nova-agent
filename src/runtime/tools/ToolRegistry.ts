/**
 * ToolRegistry — 工具注册与发现。
 * 路径边界委托 pathAccess；执行只走 toolBatchExecutor，不再提供无权限校验的 execute。
 */
import { resolve } from 'path'
import type { ToolDefinition } from '../model/types'
import type { ToolExecutor, ToolContext } from './types'
import type { PathAccessKind } from '../../shared/permissions/types'
import {
  type CanonicalPathCache,
  isPathWithinRoot,
  resolvePathAccess
} from '../permissions/pathAccess'
import { listPathGrantsForAccess } from '../permissions/pathAccess/sessionPathGrants'

export type ResolveResult =
  | { ok: true; path: string }
  | { ok: false; error: string }

export type ResolvePathOptions = {
  sessionId?: string
  toolCallId?: string
  access?: PathAccessKind
  cache?: CanonicalPathCache
}

/**
 * 工具名大小写模糊解析结果：
 * 唯一命中给出正确名字；多候选给出候选列表；未命中由调用方维持原错误。
 */
export type ToolNameCaseResolution =
  | { kind: 'unique'; name: string }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'miss' }

export function resolveAndValidatePath(
  workingDir: string,
  inputPath: string,
  options?: ResolvePathOptions
): ResolveResult {
  const access = options?.access ?? 'read'
  const grants = options?.sessionId
    ? listPathGrantsForAccess(options.sessionId, options.toolCallId)
    : []
  const resolved = resolvePathAccess({
    workingDir,
    inputPath,
    access,
    grants,
    cache: options?.cache
  })
  if (!resolved.ok) {
    return { ok: false, error: resolved.reason }
  }
  if (resolved.scope === 'external') {
    return { ok: false, error: `路径越界: "${inputPath}" 位于工作区 "${workingDir}" 之外` }
  }
  return { ok: true, path: resolved.canonical }
}

export function resolveAndValidateToolPath(
  context: Pick<ToolContext, 'workingDir' | 'sessionId' | 'invocationRef'>,
  inputPath: string,
  access: PathAccessKind,
  cache?: CanonicalPathCache
): ResolveResult {
  return resolveAndValidatePath(context.workingDir, inputPath, {
    sessionId: context.sessionId,
    toolCallId: context.invocationRef?.toolCallId,
    access,
    cache
  })
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

  /**
   * 大小写不敏感解析工具名，供模型写错大小写时自愈。
   * 精确匹配不在此方法职责内（调用方先走 getTool），此处只统计
   * toLowerCase 相等的已注册名：唯一命中才可安全纠正，多候选无法判断正主。
   */
  resolveToolNameCaseInsensitive(name: string): ToolNameCaseResolution {
    const lower = name.toLowerCase()
    const candidates: string[] = []
    for (const registered of this.tools.keys()) {
      if (registered.toLowerCase() === lower) {
        candidates.push(registered)
      }
    }
    if (candidates.length === 1) return { kind: 'unique', name: candidates[0] }
    if (candidates.length > 1) return { kind: 'ambiguous', candidates }
    return { kind: 'miss' }
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

  /** 将相对路径解析为绝对路径（不验证边界） */
  resolvePath(workingDir: string, inputPath: string): string {
    return resolve(workingDir, inputPath)
  }

  /** 判断目标路径是否在工作区内（canonical 语义，与 resolveAndValidatePath 同源） */
  isWithinWorkspace(workingDir: string, inputPath: string): boolean {
    const resolved = resolveAndValidatePath(workingDir, inputPath)
    return resolved.ok
  }

  /** 解析路径并验证工作区边界 */
  resolveAndValidate(workingDir: string, inputPath: string): ResolveResult {
    return resolveAndValidatePath(workingDir, inputPath)
  }
}

export { isPathWithinRoot }
