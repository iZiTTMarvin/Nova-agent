/**
 * SkillLoader — 多源扫描、优先级覆盖、错误收集
 * 优先级：builtin(0) < third_party_claude(1) < global(2) < project(3)
 */
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { parseSkillMarkdown } from './frontmatter'
import type { LoadError, SkillManifest, SkillSource } from './types'

const SKILL_FILE = 'SKILL.md'
const MAX_CONTEXT_SKILLS = 30
const SKIP_DIRS = new Set(['node_modules', '.git', '.archive'])

/** 各来源优先级（数值越大越优先） */
export const SOURCE_PRIORITY: Record<SkillSource, number> = {
  builtin: 0,
  virtual: 0,
  mcp: 0,
  third_party_claude: 1,
  global: 2,
  project: 3
}

export interface SkillLoaderOptions {
  builtinDir?: string
  globalDir?: string
  projectDir?: string
  /** 第三方 Claude skill 缓存目录（Task 13 写入，MVP 可选传入） */
  thirdPartyDir?: string
}

export interface SkillLoadResult {
  skills: SkillManifest[]
  errors: LoadError[]
  shadowed: Record<string, SkillSource>
}

/**
 * 解析默认路径
 */
export function resolveDefaultSkillDirs(opts: SkillLoaderOptions = {}): Required<Pick<SkillLoaderOptions, 'globalDir'>> & SkillLoaderOptions {
  return {
    builtinDir: opts.builtinDir,
    globalDir: opts.globalDir ?? join(homedir(), '.nova', 'skills'),
    projectDir: opts.projectDir,
    thirdPartyDir: opts.thirdPartyDir
  }
}

/**
 * 解析 builtin 技能目录。
 *
 * 三种运行态各自命中一个候选，互不干扰：
 *   1. 打包态：主进程被 bundle 进 out/main/index.js，运行时 __dirname 指向
 *      app.asar/out/main/，而 copyNovaBuiltinSkills 插件已把 .nova/skills
 *      复制到 out/main/.nova/skills —— 此候选直接命中，与 prompts/workflow
 *      的 __dirname 定位机制完全一致（asar 内可读，无需 asarUnpack）。
 *   2. 测试 / 注入态：getAppPath() 指向的根下直接挂 .nova/skills
 *      （SkillService.test 用例构造的 appRoot 形态），优先级高于 cwd 兜底。
 *   3. 开发态（electron-vite dev，无 getAppPath 或返回项目根的 .nova/skills
 *      不存在时）：回退到 process.cwd()/.nova/skills，即项目源码根目录。
 *
 * 不再用 app.getAppPath() 作为打包态首选——它返回 asar 根，而资源实际在
 * asar/out/main/ 下，二者路径错位会导致打包后 builtin skills 全部丢失。
 */
export function resolveDevBuiltinDir(): string {
  return join(process.cwd(), '.nova', 'skills')
}

export function resolveBuiltinSkillsDir(getAppPath?: () => string): string {
  // 打包态首选：与 prompts / workflow 内置脚本使用同一套 __dirname 定位机制
  const dirBasedBuiltin = join(__dirname, '.nova', 'skills')
  if (existsSync(dirBasedBuiltin)) return dirBasedBuiltin

  // 测试 / 注入态：getAppPath 根下直接挂 .nova/skills
  if (getAppPath) {
    const appBuiltin = join(getAppPath(), '.nova', 'skills')
    if (existsSync(appBuiltin)) return appBuiltin
  }

  // 开发态兜底：项目根 .nova/skills
  return resolveDevBuiltinDir()
}

export class SkillLoader {
  private skills = new Map<string, SkillManifest>()
  private errors: LoadError[] = []
  private shadowed: Record<string, SkillSource> = {}

  private constructor(
    skills: Map<string, SkillManifest>,
    errors: LoadError[],
    shadowed: Record<string, SkillSource>
  ) {
    this.skills = skills
    this.errors = errors
    this.shadowed = shadowed
  }

  /**
   * 扫描全部来源并合并
   */
  static loadAll(opts: SkillLoaderOptions = {}): SkillLoader {
    const dirs = resolveDefaultSkillDirs(opts)
    const merged = new Map<string, SkillManifest>()
    const errors: LoadError[] = []
    const shadowed: Record<string, SkillSource> = {}

    const sources: Array<{ dir: string | undefined; source: SkillSource }> = [
      { dir: dirs.builtinDir, source: 'builtin' },
      { dir: dirs.thirdPartyDir, source: 'third_party_claude' },
      { dir: dirs.globalDir, source: 'global' },
      { dir: dirs.projectDir, source: 'project' }
    ]

    for (const { dir, source } of sources) {
      if (!dir) continue
      SkillLoader.scanDir(dir, source, merged, errors, shadowed)
    }

    return new SkillLoader(merged, errors, shadowed)
  }

  private static scanDir(
    dir: string,
    source: SkillSource,
    target: Map<string, SkillManifest>,
    errors: LoadError[],
    shadowed: Record<string, SkillSource>
  ): void {
    if (!existsSync(dir)) return

    let entries: string[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory() && !SKIP_DIRS.has(e.name))
        .map(e => e.name)
    } catch (err) {
      errors.push({ path: dir, message: (err as Error).message })
      return
    }

    for (const dirName of entries) {
      const skillDir = join(dir, dirName)
      const skillPath = join(skillDir, SKILL_FILE)
      if (!existsSync(skillPath)) continue

      try {
        const content = readFileSync(skillPath, 'utf-8')
        const manifest = parseSkillMarkdown(content, {
          fallbackName: dirName,
          source,
          sourcePath: skillPath,
          directory: skillDir
        })

        if (manifest.invalid) {
          errors.push({
            path: skillPath,
            message: manifest.invalidReason ?? 'invalid manifest',
            skillName: manifest.name
          })
        } else if (manifest.warnings.length > 0) {
          errors.push({
            path: skillPath,
            message: manifest.warnings.join('; '),
            skillName: manifest.name
          })
        }

        const existing = target.get(manifest.name)
        if (existing) {
          const existingPri = SOURCE_PRIORITY[existing.source]
          const newPri = SOURCE_PRIORITY[source]
          if (newPri >= existingPri) {
            shadowed[manifest.name] = existing.source
            target.set(manifest.name, manifest)
          } else {
            shadowed[manifest.name] = source
          }
        } else {
          target.set(manifest.name, manifest)
        }
      } catch (err) {
        errors.push({
          path: skillPath,
          message: (err as Error).message,
          skillName: dirName
        })
      }
    }
  }

  get(name: string): SkillManifest | undefined {
    return this.skills.get(name)
  }

  getErrors(): LoadError[] {
    return [...this.errors]
  }

  getShadowed(): Record<string, SkillSource> {
    return { ...this.shadowed }
  }

  /** 全部技能（未截断） */
  listAll(): SkillManifest[] {
    return [...this.skills.values()]
  }

  /**
   * 模型可见技能：enabled + modelInvocable + agent 域 + 上限 30。
   * 默认过滤 hidden；compose 模式传 includeHidden=true。
   */
  listForContext(profile?: string, opts?: { includeHidden?: boolean }): SkillManifest[] {
    const includeHidden = opts?.includeHidden === true
    const filtered = [...this.skills.values()].filter(s => {
      if (!s.enabled || !s.modelInvocable || s.invalid) return false
      if (s.hidden && !includeHidden) return false
      return SkillLoader.isAgentAllowed(s, profile)
    })
    return filtered.slice(0, MAX_CONTEXT_SKILLS)
  }

  /** 仅隐藏编排 skill（compose_skills 块用） */
  listHidden(): SkillManifest[] {
    return [...this.skills.values()].filter(
      s => s.hidden && s.enabled && !s.invalid
    )
  }

  /** 用户可 slash 调用的技能（含 workflow 入口，不含 hidden） */
  listUserInvocable(): SkillManifest[] {
    return [...this.skills.values()].filter(
      s => s.userInvocable && !s.invalid && !s.hidden
    )
  }

  /** 判断当前 profile 是否允许使用该 skill */
  static isAgentAllowed(skill: SkillManifest, profile?: string): boolean {
    if (!skill.agent) return true
    if (!profile) return true
    const agents = Array.isArray(skill.agent) ? skill.agent : [skill.agent]
    return agents.includes(profile)
  }

  findBySlashCommand(input: string): SkillManifest | undefined {
    const trimmed = input.trim()
    if (!trimmed.startsWith('/')) return undefined
    const m = trimmed.match(/^\/(\S+?)(?:\s+|$)/)
    if (!m) return undefined
    return this.get(m[1])
  }
}
