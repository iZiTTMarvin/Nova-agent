/**
 * 技能目录枚举：跟随符号链接，并按真实路径去重。
 * `.claude/skills` 里常见指向 `.agents/skills` 的链接，只看 Dirent 类型会漏掉它们。
 */
import { existsSync, readdirSync, realpathSync, statSync } from 'fs'
import { join } from 'path'

export const SKILL_FILE = 'SKILL.md'
export const SKIP_SKILL_DIRS = new Set(['node_modules', '.git', '.archive'])

export interface SkillDirEntry {
  name: string
  /** 沿用来源目录下的路径（可能是符号链接），技能目录授权时再解析真实路径 */
  path: string
}

function isDirectoryEntry(parent: string, entry: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }): boolean {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return statSync(join(parent, entry.name)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 列出 `dir` 下含 SKILL.md 的技能目录。readdir 失败时抛出，由调用方决定是记录错误还是忽略。
 * `seenRealPaths` 在同一组来源间共享时，同一真实目录只返回一次。
 */
export function listSkillDirs(dir: string, seenRealPaths?: Set<string>): SkillDirEntry[] {
  if (!existsSync(dir)) return []
  const result: SkillDirEntry[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_SKILL_DIRS.has(entry.name) || !isDirectoryEntry(dir, entry)) continue
    const path = join(dir, entry.name)
    if (!existsSync(join(path, SKILL_FILE))) continue
    if (seenRealPaths) {
      let real: string
      try {
        real = realpathSync(path)
      } catch {
        continue
      }
      if (seenRealPaths.has(real)) continue
      seenRealPaths.add(real)
    }
    result.push({ name: entry.name, path })
  }
  return result
}

/** 目录下可识别的技能数；目录不可读时按 0 处理 */
export function countSkillDirs(dir: string): number {
  try {
    return listSkillDirs(dir).length
  } catch {
    return 0
  }
}
