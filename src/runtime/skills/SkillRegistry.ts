/**
 * SkillRegistry — 扫描并缓存本地技能包
 * 项目级 .nova/skills 覆盖全局 ~/.nova/skills
 */
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { parseSkillMarkdown, type SkillManifest } from './SkillManifest'

const MAX_CONTEXT_SKILLS = 30
const SKILL_FILE = 'SKILL.md'
let warnedTruncation = false

export class SkillRegistry {
  private skills = new Map<string, SkillManifest>()

  private constructor(skills: Map<string, SkillManifest>) {
    this.skills = skills
  }

  /**
   * 扫描全局与项目技能目录
   * @param opts.globalDir 默认 ~/.nova/skills
   * @param opts.projectDir 工作区 .nova/skills（优先级更高）
   */
  static load(opts: { globalDir?: string; projectDir?: string } = {}): SkillRegistry {
    const globalDir = opts.globalDir ?? join(homedir(), '.nova', 'skills')
    const merged = new Map<string, SkillManifest>()

    SkillRegistry.scanDir(globalDir, merged)
    if (opts.projectDir) SkillRegistry.scanDir(opts.projectDir, merged)

    const list = [...merged.values()]
    if (list.length > MAX_CONTEXT_SKILLS) {
      if (!warnedTruncation) {
        console.warn(`[SkillRegistry] 技能超过 ${MAX_CONTEXT_SKILLS} 条，已截断`)
        warnedTruncation = true
      }
      const trimmed = new Map(list.slice(0, MAX_CONTEXT_SKILLS).map(s => [s.name, s]))
      return new SkillRegistry(trimmed)
    }
    return new SkillRegistry(merged)
  }

  /** 重置截断 warn 标志（测试用） */
  static resetWarnFlag(): void {
    warnedTruncation = false
  }

  private static scanDir(dir: string, target: Map<string, SkillManifest>): void {
    if (!existsSync(dir)) return
    let entries: string[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
    } catch {
      return
    }
    for (const name of entries) {
      const skillPath = join(dir, name, SKILL_FILE)
      if (!existsSync(skillPath)) continue
      try {
        const content = readFileSync(skillPath, 'utf-8')
        const manifest = parseSkillMarkdown(content, name)
        if (manifest) target.set(manifest.name, manifest)
      } catch {
        // 非法 manifest 跳过，不影响其他技能
      }
    }
  }

  /** 模型可见技能列表 */
  listForContext(): SkillManifest[] {
    return [...this.skills.values()].filter(s => s.modelInvocable)
  }

  /** 按名称查找 */
  get(name: string): SkillManifest | undefined {
    return this.skills.get(name)
  }

  /** 用户可 slash 调用的技能 */
  listUserInvocable(): SkillManifest[] {
    return [...this.skills.values()].filter(s => s.userInvocable)
  }
}
