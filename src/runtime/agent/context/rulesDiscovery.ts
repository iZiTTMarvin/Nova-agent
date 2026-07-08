/**
 * rulesDiscovery — 枚举工作区与全局规则文件
 * 供设置页 Rules 面板与后续 AgentLoop 注入（Task 14）
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, relative, resolve, normalize, isAbsolute } from 'path'
import { getNovaHomeDir } from '../../settings/novaSettings'

/** 工作区根目录下的经典规则文件名 */
const WORKSPACE_RULE_FILES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules'] as const

export type RuleScope = 'workspace' | 'global'

/** 规则文件条目（IPC 安全） */
export interface RuleFileEntry {
  id: string
  relativePath: string
  absolutePath: string
  scope: RuleScope
  editable: boolean
}

/**
 * 校验绝对路径是否在指定根目录内（防路径穿越）。
 * Windows 跨盘符时 path.relative 会返回绝对路径（不以 .. 开头），必须用 isAbsolute 拦截。
 */
export function isPathInsideRoot(targetPath: string, root: string): boolean {
  const resolvedRoot = resolve(normalize(root))
  const resolvedTarget = resolve(normalize(targetPath))
  const rel = relative(resolvedRoot, resolvedTarget)
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return !rel.startsWith('..')
}

function listGlobalNovaRules(): RuleFileEntry[] {
  const rulesDir = join(getNovaHomeDir(), 'rules')
  if (!existsSync(rulesDir)) return []
  try {
    return readdirSync(rulesDir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const absolutePath = join(rulesDir, f)
        const relativePath = `.nova/rules/${f}`
        return {
          id: `global:${relativePath}`,
          relativePath,
          absolutePath,
          scope: 'global' as const,
          editable: true
        }
      })
  } catch {
    return []
  }
}

function listWorkspaceRules(workspaceRoot: string): RuleFileEntry[] {
  const entries: RuleFileEntry[] = []

  for (const file of WORKSPACE_RULE_FILES) {
    const absolutePath = join(workspaceRoot, file)
    if (existsSync(absolutePath)) {
      entries.push({
        id: `workspace:${file}`,
        relativePath: file,
        absolutePath,
        scope: 'workspace',
        editable: true
      })
    }
  }

  const novaRulesDir = join(workspaceRoot, '.nova', 'rules')
  if (existsSync(novaRulesDir)) {
    try {
      for (const f of readdirSync(novaRulesDir)) {
        if (!f.endsWith('.md')) continue
        const absolutePath = join(novaRulesDir, f)
        entries.push({
          id: `workspace:.nova/rules/${f}`,
          relativePath: `.nova/rules/${f}`,
          absolutePath,
          scope: 'workspace',
          editable: true
        })
      }
    } catch {
      // 忽略不可读目录
    }
  }

  return entries
}

/** 枚举全部可见规则文件 */
export function listRuleFiles(workspaceRoot?: string | null): RuleFileEntry[] {
  const global = listGlobalNovaRules()
  const workspace = workspaceRoot ? listWorkspaceRules(workspaceRoot) : []
  return [...workspace, ...global]
}

/** 读取规则正文 */
export function readRuleFile(absolutePath: string): string {
  return readFileSync(absolutePath, 'utf-8')
}

/** 写入规则正文 */
export function writeRuleFile(absolutePath: string, content: string): void {
  const dir = dirname(absolutePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(absolutePath, content, 'utf-8')
}

/** 新建工作区 .nova/rules 文件路径 */
export function buildNewWorkspaceRulePath(workspaceRoot: string, name: string): string {
  const slug = name.trim().replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-') || 'rule'
  return join(workspaceRoot, '.nova', 'rules', `${slug}.md`)
}

/** 新建全局 .nova/rules 文件路径 */
export function buildNewGlobalRulePath(name: string): string {
  const slug = name.trim().replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-') || 'rule'
  return join(getNovaHomeDir(), 'rules', `${slug}.md`)
}
