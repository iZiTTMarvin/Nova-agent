/**
 * projectRulesDiscovery — 扫描工作区项目规则文件
 * 优先级：AGENTS.md > CLAUDE.md > .cursorrules
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const RULE_FILES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules'] as const

/**
 * 发现项目规则文本
 * @param workspaceRoot 工作区根目录
 * @returns 规则正文；未找到返回 null
 */
export function discoverProjectRules(workspaceRoot: string): string | null {
  for (const file of RULE_FILES) {
    const fullPath = join(workspaceRoot, file)
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, 'utf-8').trim()
        return content || null
      } catch {
        continue
      }
    }
  }
  return null
}

/** 返回命中的规则文件名（测试 / 诊断用） */
export function discoverProjectRulesFile(workspaceRoot: string): string | null {
  for (const file of RULE_FILES) {
    if (existsSync(join(workspaceRoot, file))) return file
  }
  return null
}
