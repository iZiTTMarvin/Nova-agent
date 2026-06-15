/**
 * PermissionService — 权限规则持久化服务（PRD §5.2）
 *
 * 持久化策略：
 * - 全局规则：~/.nova/permissions.json
 * - 项目规则：<projectPath>/.nova/permissions.json
 *
 * 安全约束（PRD §5.2.5 / 风险表）：
 * - 项目级规则只能通过 UI（用户主动操作）写入，不允许 agent 代码或工具静默写入。
 * - upsert 语义：相同 id 的规则覆盖，避免重复"始终允许"堆积。
 * - 删除按 id 定位。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, isAbsolute } from 'path'
import { homedir } from 'os'
import { createPermissionRule, type PermissionRule } from './PermissionRule'

const GLOBAL_DIR = join(homedir(), '.nova')
const GLOBAL_FILE = join(GLOBAL_DIR, 'permissions.json')
const PROJECT_DIR_NAME = '.nova'
const PROJECT_FILE_NAME = 'permissions.json'

/** 读取持久化规则文件（返回空数组当文件不存在或损坏） */
function readRulesFile(filePath: string): PermissionRule[] {
  if (!existsSync(filePath)) return []
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
    if (Array.isArray(raw)) return raw as PermissionRule[]
    return []
  } catch {
    return []
  }
}

/** 写入规则文件（确保目录存在） */
function writeRulesFile(filePath: string, dir: string, rules: PermissionRule[]): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(filePath, JSON.stringify(rules, null, 2), 'utf-8')
}

/** 项目规则文件路径 */
function projectFilePath(projectPath: string): string {
  return join(projectPath, PROJECT_DIR_NAME, PROJECT_FILE_NAME)
}

/** 列出全局 + 指定项目的所有规则 */
export function listPermissionRules(projectPath: string | null): PermissionRule[] {
  const globalRules = readRulesFile(GLOBAL_FILE)
  const projectRules = projectPath ? readRulesFile(projectFilePath(projectPath)) : []
  return [...projectRules, ...globalRules]
}

/** 列出全局规则 */
export function listGlobalRules(): PermissionRule[] {
  return readRulesFile(GLOBAL_FILE)
}

/** 列出指定项目的规则 */
export function listProjectRules(projectPath: string): PermissionRule[] {
  return readRulesFile(projectFilePath(projectPath))
}

/**
 * 新增/更新一条规则（upsert 语义：相同 id 覆盖）。
 *
 * 安全约束：
 * - 项目级规则的 projectPath 必须是合法绝对路径，且与传入的 projectPath 一致。
 * - 不允许 scope=project 但 projectPath 为空。
 */
export function upsertPermissionRule(input: {
  toolName: PermissionRule['toolName']
  behavior: PermissionRule['behavior']
  scope: PermissionRule['scope']
  projectPath?: string
  commandPrefix?: string
  commandRegex?: string
  filePath?: string
  description?: string
}): PermissionRule {
  // 校验项目级规则的路径
  if (input.scope === 'project') {
    if (!input.projectPath || !isAbsolute(input.projectPath)) {
      throw new Error('项目级规则必须提供合法绝对路径的 projectPath')
    }
  }

  const rule = createPermissionRule(input)
  const filePath = input.scope === 'project' && input.projectPath
    ? projectFilePath(input.projectPath)
    : GLOBAL_FILE
  const dir = input.scope === 'project' && input.projectPath
    ? join(input.projectPath, PROJECT_DIR_NAME)
    : GLOBAL_DIR

  const existing = readRulesFile(filePath)
  // upsert：相同 id 覆盖，其余保留
  const next = [...existing.filter(r => r.id !== rule.id), rule]
  writeRulesFile(filePath, dir, next)
  return rule
}

/** 按 id 删除规则（同时尝试全局与项目文件） */
export function deletePermissionRule(ruleId: string, projectPath: string | null): boolean {
  let removed = false

  // 全局
  const globalRules = readRulesFile(GLOBAL_FILE)
  const filteredGlobal = globalRules.filter(r => r.id !== ruleId)
  if (filteredGlobal.length !== globalRules.length) {
    writeRulesFile(GLOBAL_FILE, GLOBAL_DIR, filteredGlobal)
    removed = true
  }

  // 项目
  if (projectPath && isAbsolute(projectPath)) {
    const pFile = projectFilePath(projectPath)
    const pRules = readRulesFile(pFile)
    const filteredP = pRules.filter(r => r.id !== ruleId)
    if (filteredP.length !== pRules.length) {
      writeRulesFile(pFile, join(projectPath, PROJECT_DIR_NAME), filteredP)
      removed = true
    }
  }

  return removed
}
