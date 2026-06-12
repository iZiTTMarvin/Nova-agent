/**
 * Claude Code 第三方 skill 适配器
 * 只读扫描 ~/.claude/skills 与 <workspace>/.claude/skills，
 * 按 mtime 增量同步到 ~/.nova/imported/claude-skills/ 缓存目录（策略 B）
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getNovaHomeDir } from '../settings/novaSettings'

const SKILL_FILE = 'SKILL.md'
const SKIP_DIRS = new Set(['node_modules', '.git', '.archive'])

export interface ClaudeSyncOptions {
  /** 是否启用第三方 skill 加载 */
  enabled: boolean
  /** 当前工作区根目录（可选，用于项目级 .claude/skills） */
  workspaceRoot?: string | null
  /** Nova 主目录，默认 ~/.nova */
  novaHomeDir?: string
}

export interface ClaudeSyncResult {
  /** 合并后的缓存根目录，供 SkillLoader.thirdPartyDir 使用 */
  cacheDir: string
  /** 本次同步的技能数量 */
  syncedCount: number
}

/** Claude Code 全局技能目录 */
export function resolveClaudeGlobalSkillsDir(): string {
  return join(homedir(), '.claude', 'skills')
}

/** Claude Code 项目技能目录 */
export function resolveClaudeProjectSkillsDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.claude', 'skills')
}

/** 第三方 skill 缓存根目录 */
export function resolveClaudeSkillsCacheDir(novaHomeDir?: string): string {
  return join(novaHomeDir ?? getNovaHomeDir(), 'imported', 'claude-skills')
}

/**
 * 同步 Claude Code 技能到 Nova 缓存目录
 * @returns 缓存目录路径；开关关闭或无可同步内容时返回 undefined
 */
export function syncClaudeCodeSkills(opts: ClaudeSyncOptions): ClaudeSyncResult | undefined {
  if (!opts.enabled) {
    return undefined
  }

  const cacheDir = resolveClaudeSkillsCacheDir(opts.novaHomeDir)
  mkdirSync(cacheDir, { recursive: true })

  // 清空旧缓存后重建，保证关闭项目级 skill 后不会残留
  if (existsSync(cacheDir)) {
    for (const entry of readdirSync(cacheDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        rmSync(join(cacheDir, entry.name), { recursive: true, force: true })
      }
    }
  }

  let syncedCount = 0

  // 先全局后项目，同名时项目覆盖（对齐优先级 project > global within third_party）
  const globalDir = resolveClaudeGlobalSkillsDir()
  syncedCount += syncScope(globalDir, cacheDir)

  if (opts.workspaceRoot) {
    const projectDir = resolveClaudeProjectSkillsDir(opts.workspaceRoot)
    syncedCount += syncScope(projectDir, cacheDir, { overwrite: true })
  }

  if (syncedCount === 0) {
    return { cacheDir, syncedCount: 0 }
  }

  return { cacheDir, syncedCount }
}

interface SyncScopeOptions {
  /** 允许覆盖缓存中已有同名技能（项目级覆盖全局） */
  overwrite?: boolean
}

/**
 * 将单个 Claude 技能目录同步到缓存根目录
 */
function syncScope(
  sourceRoot: string,
  cacheRoot: string,
  opts: SyncScopeOptions = {}
): number {
  if (!existsSync(sourceRoot)) return 0

  let count = 0
  let entries: string[]
  try {
    entries = readdirSync(sourceRoot, { withFileTypes: true })
      .filter(e => e.isDirectory() && !SKIP_DIRS.has(e.name))
      .map(e => e.name)
  } catch {
    return 0
  }

  for (const dirName of entries) {
    const sourceDir = join(sourceRoot, dirName)
    const sourceSkillPath = join(sourceDir, SKILL_FILE)
    if (!existsSync(sourceSkillPath)) continue

    const targetDir = join(cacheRoot, dirName)
    if (!opts.overwrite && existsSync(targetDir)) {
      continue
    }

    if (shouldSyncSkillDir(sourceDir, targetDir)) {
      if (existsSync(targetDir)) {
        rmSync(targetDir, { recursive: true, force: true })
      }
      copySkillDirectory(sourceDir, targetDir)
      count += 1
    }
  }

  return count
}

/** 源目录 SKILL.md 更新或缓存缺失时需要同步 */
function shouldSyncSkillDir(sourceDir: string, targetDir: string): boolean {
  const sourceSkill = join(sourceDir, SKILL_FILE)
  const targetSkill = join(targetDir, SKILL_FILE)

  if (!existsSync(targetDir) || !existsSync(targetSkill)) {
    return true
  }

  try {
    const sourceMtime = statSync(sourceSkill).mtimeMs
    const targetMtime = statSync(targetSkill).mtimeMs
    return sourceMtime > targetMtime
  } catch {
    return true
  }
}

/** 复制技能目录（SKILL.md + 附属文件/子目录） */
function copySkillDirectory(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true })

  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const src = join(sourceDir, entry.name)
    const dest = join(targetDir, entry.name)
    if (entry.isDirectory()) {
      cpSync(src, dest, { recursive: true })
    } else if (entry.isFile()) {
      cpSync(src, dest)
    }
  }

  // 记录源路径，便于调试（不影响 frontmatter 解析）
  try {
    writeFileSync(join(targetDir, '.nova-claude-source'), sourceDir, 'utf-8')
  } catch {
    // 标记文件写入失败不影响加载
  }
}
