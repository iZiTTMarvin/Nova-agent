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
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import type { Dirent } from 'fs'
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
 *
 * 增量同步：缓存与源一致时零拷贝（启动路径不能因第三方技能数量变慢）。
 * 一致 = 缓存来源标记匹配当前胜出源，且源目录无任何文件比上次同步时刻新。
 * 孤儿（源已删除）与换源（工作区切换后同名技能换了来源）整目录重建。
 *
 * @returns 缓存目录路径；开关关闭时返回 undefined
 */
export function syncClaudeCodeSkills(opts: ClaudeSyncOptions): ClaudeSyncResult | undefined {
  if (!opts.enabled) {
    return undefined
  }

  const cacheDir = resolveClaudeSkillsCacheDir(opts.novaHomeDir)
  mkdirSync(cacheDir, { recursive: true })

  // 期望集：先全局后项目，同名时项目覆盖（对齐优先级 project > global within third_party）
  const sources = new Map<string, string>()
  collectSourceSkillDirs(resolveClaudeGlobalSkillsDir(), sources)
  if (opts.workspaceRoot) {
    collectSourceSkillDirs(resolveClaudeProjectSkillsDir(opts.workspaceRoot), sources)
  }

  let syncedCount = 0

  let cacheEntries: string[] = []
  try {
    cacheEntries = readdirSync(cacheDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
  } catch {
    cacheEntries = []
  }

  for (const name of cacheEntries) {
    const targetDir = join(cacheDir, name)
    const sourceDir = sources.get(name)
    if (sourceDir && isCacheUpToDate(targetDir, sourceDir)) {
      continue
    }
    rmSync(targetDir, { recursive: true, force: true })
    if (sourceDir) {
      copySkillDirectory(sourceDir, targetDir)
      syncedCount += 1
    }
  }

  for (const [name, sourceDir] of sources) {
    const targetDir = join(cacheDir, name)
    if (!existsSync(targetDir)) {
      copySkillDirectory(sourceDir, targetDir)
      syncedCount += 1
    }
  }

  return { cacheDir, syncedCount }
}

/** 记录缓存来源的标记文件（copySkillDirectory 写入） */
const SOURCE_MARKER_FILE = '.nova-claude-source'

function collectSourceSkillDirs(sourceRoot: string, sources: Map<string, string>): void {
  if (!existsSync(sourceRoot)) return
  let entries: string[]
  try {
    entries = readdirSync(sourceRoot, { withFileTypes: true })
      .filter(e => e.isDirectory() && !SKIP_DIRS.has(e.name))
      .map(e => e.name)
  } catch {
    return
  }
  for (const dirName of entries) {
    if (existsSync(join(sourceRoot, dirName, SKILL_FILE))) {
      sources.set(dirName, join(sourceRoot, dirName))
    }
  }
}

function isCacheUpToDate(targetDir: string, sourceDir: string): boolean {
  try {
    if (readFileSync(join(targetDir, SOURCE_MARKER_FILE), 'utf-8') !== sourceDir) {
      return false
    }
  } catch {
    return false
  }
  return !shouldSyncSkillDir(sourceDir, targetDir)
}

/**
 * 源 SKILL.md 或任一附属文件比上次同步时刻新时需要整目录重建。
 * 上次同步时刻取缓存标记文件的 mtime（它在全部拷贝完成后写入）；
 * 附属文件（脚本、参考文档）单独改动因此也能被检测到。
 */
function shouldSyncSkillDir(sourceDir: string, targetDir: string): boolean {
  const targetSkill = join(targetDir, SKILL_FILE)

  if (!existsSync(targetDir) || !existsSync(targetSkill)) {
    return true
  }

  let syncTimeMs: number
  try {
    syncTimeMs = statSync(join(targetDir, SOURCE_MARKER_FILE)).mtimeMs
  } catch {
    return true
  }

  const stack = [sourceDir]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const filePath = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(filePath)
        continue
      }
      if (!entry.isFile()) continue
      try {
        if (statSync(filePath).mtimeMs > syncTimeMs) return true
      } catch {
        // 单个文件不可读不触发重建，拷贝阶段自会暴露问题
      }
    }
  }
  return false
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
    writeFileSync(join(targetDir, SOURCE_MARKER_FILE), sourceDir, 'utf-8')
  } catch {
    // 标记文件写入失败不影响加载
  }
}
