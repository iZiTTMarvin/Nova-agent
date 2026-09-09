/**
 * SkillService — 桌面端技能管理单例
 * 封装加载、CRUD、启停持久化与导入导出
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { syncClaudeCodeSkills } from './ClaudeCodeSkillAdapter'
import { SkillRegistry } from './SkillRegistry'
import { MAX_CONTEXT_SKILLS, resolveBuiltinSkillsDir } from './SkillLoader'
import { loadNovaSettings } from '../settings/novaSettings'
import {
  createTempSkillDir,
  createZipFromDirectory,
  downloadHttpsToFile,
  extractZip,
  findSkillRoot,
  isZipPath,
  validateSkillDirectory
} from './skillZip'
import type { SkillManifest } from './types'
import type {
  SkillCatalogDiagnostic,
  SkillCreateInput,
  SkillCreateLocation,
  SkillImportInput,
  SkillModelBudget,
  SkillReloadResult,
  SkillSummary
} from '../../shared/skills/types'

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const BODY_PREVIEW_LEN = 280
const SKILL_STATE_FILE = 'skill-state.json'

export interface SkillServiceOptions {
  /** Electron app.getAppPath；用于定位 builtin 目录 */
  getAppPath?: () => string
  /** 全局技能目录，默认 ~/.nova/skills */
  globalDir?: string
  /** skill-state.json 所在目录，默认 ~/.nova */
  novaHomeDir?: string
}

/** 将完整 manifest 转为 IPC 安全摘要 */
export function toSkillSummary(skill: SkillManifest): SkillSummary {
  return {
    name: skill.name,
    nameZh: skill.nameZh,
    description: skill.description,
    descriptionZh: skill.descriptionZh,
    source: skill.source,
    sourcePath: skill.sourcePath,
    userInvocable: skill.userInvocable,
    modelInvocable: skill.modelInvocable,
    enabled: skill.enabled,
    invalid: skill.invalid,
    invalidReason: skill.invalidReason,
    warnings: skill.warnings,
    bodyPreview: skill.body.slice(0, BODY_PREVIEW_LEN),
    argumentHint: skill.argumentHint,
    hasSupportingFiles: skill.hasSupportingFiles,
    forkAgent: skill.forkAgent,
    hidden: skill.hidden ?? false
  }
}

/**
 * 把注册表的加载错误、来源遮蔽、模式限制与模型开关投影为目录诊断。
 * 无效技能只保留加载错误，不叠加次级说明。排序稳定（名称 → 路径 → code），
 * 不依赖文件系统枚举顺序。
 */
export function toCatalogDiagnostics(registry: SkillRegistry): SkillCatalogDiagnostic[] {
  const diagnostics: SkillCatalogDiagnostic[] = registry.getErrors().map(e => ({
    code: 'load_error' as const,
    message: e.message,
    ...(e.skillName ? { skillName: e.skillName } : {}),
    path: e.path
  }))
  for (const [name, source] of Object.entries(registry.getShadowed()).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    diagnostics.push({
      code: 'shadowed',
      message: `技能「${name}」被高优先级来源覆盖，${source} 版本未生效`,
      skillName: name
    })
  }
  for (const skill of registry.getLoader().listAll()) {
    if (skill.invalid) continue
    if (skill.agent !== undefined) {
      const agents = Array.isArray(skill.agent) ? skill.agent : [skill.agent]
      diagnostics.push({
        code: 'profile_restricted',
        message: `仅 ${agents.join('、')} 模式可用`,
        skillName: skill.name
      })
    }
    if (skill.modelInvocable && !skill.enabled) {
      diagnostics.push({
        code: 'model_disabled',
        message: '已关闭模型调用',
        skillName: skill.name
      })
    }
  }
  // 预算压力是目录级的（未按会话 profile 过滤），超过上限才出现一条
  const budget = registry.getContextProjection()
  if (budget.omittedCount > 0) {
    diagnostics.push({
      code: 'budget_omitted',
      message: `模型上下文最多收录前 ${MAX_CONTEXT_SKILLS} 个技能，目录有 ${budget.eligible} 个模型可用技能`
    })
  }
  diagnostics.sort((a, b) =>
    (a.skillName ?? a.path ?? '').localeCompare(b.skillName ?? b.path ?? '') ||
    a.code.localeCompare(b.code)
  )
  return diagnostics
}

export class SkillService {
  private registry: SkillRegistry | null = null
  private workspaceRoot: string | null = null
  private readonly getAppPath?: () => string
  private readonly globalDir: string
  private readonly novaHomeDir: string
  /** name → enabled，持久化到 ~/.nova/skill-state.json */
  private skillState: Record<string, boolean> = {}

  constructor(opts: SkillServiceOptions = {}) {
    this.getAppPath = opts.getAppPath
    this.globalDir = opts.globalDir ?? join(homedir(), '.nova', 'skills')
    this.novaHomeDir = opts.novaHomeDir ?? join(homedir(), '.nova')
    this.loadSkillState()
  }

  /** 加载或切换工作区 */
  load(workspaceRoot?: string | null): SkillRegistry {
    if (workspaceRoot !== undefined) {
      this.workspaceRoot = workspaceRoot
    }
    return this.reload()
  }

  /** 按当前 workspace 重新扫描（含第三方 Claude skill 同步） */
  reload(): SkillRegistry {
    const settings = loadNovaSettings()
    const claudeSync = syncClaudeCodeSkills({
      enabled: settings.loadThirdPartySkills,
      workspaceRoot: this.workspaceRoot,
      novaHomeDir: this.novaHomeDir
    })

    const builtinDir = resolveBuiltinSkillsDir(this.getAppPath)
    this.registry = SkillRegistry.load({
      workspaceRoot: this.workspaceRoot ?? undefined,
      builtinDir,
      globalDir: this.globalDir,
      // 开关开启时从缓存目录加载 third_party_claude 源
      thirdPartyDir: claudeSync?.cacheDir
    })
    this.applySkillState()
    // 诊断：builtin 为空时 `/` 补全会无候选项，便于排查打包路径错位
    const builtinCount = this.registry
      .getLoader()
      .listAll()
      .filter(s => s.source === 'builtin' && !s.invalid).length
    if (builtinCount === 0) {
      console.warn(
        `[SkillService] 未加载到任何内置技能（builtinDir=${builtinDir}）。` +
          '斜杠 `/` 补全可能为空；请确认打包 asarUnpack 与 resolveBuiltinSkillsDir 路径。'
      )
    }
    return this.registry
  }

  getRegistry(): SkillRegistry {
    if (!this.registry) {
      return this.reload()
    }
    return this.registry
  }

  getWorkspaceRoot(): string | null {
    return this.workspaceRoot
  }

  list(): SkillSummary[] {
    return this.getRegistry()
      .getLoader()
      .listAll()
      .map(toSkillSummary)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  listUserInvocable(): SkillSummary[] {
    return this.getRegistry()
      .listUserInvocable()
      .map(toSkillSummary)
  }

  get(name: string): SkillSummary | null {
    const skill = this.getRegistry().get(name)
    return skill ? toSkillSummary(skill) : null
  }

  /** 获取技能完整正文（创建模板等场景） */
  getBody(name: string): string | null {
    const skill = this.getRegistry().get(name)
    return skill?.body ?? null
  }

  /** 获取完整 manifest（主进程 Agent 调度用） */
  getManifest(name: string): SkillManifest | undefined {
    return this.getRegistry().get(name)
  }

  /**
   * 创建技能并写入 SKILL.md
   */
  create(input: SkillCreateInput): SkillSummary {
    const name = input.name.trim()
    if (!SLUG_RE.test(name)) {
      throw new Error(`技能名称 "${name}" 不是合法 slug（小写字母、数字、连字符）`)
    }
    if (!input.description.trim()) {
      throw new Error('description 不能为空')
    }

    const targetDir = join(this.resolveLocationDir(input.location), name)
    if (existsSync(targetDir)) {
      throw new Error(`技能目录已存在：${targetDir}`)
    }

    mkdirSync(targetDir, { recursive: true })
    const skillPath = join(targetDir, 'SKILL.md')
    const content = buildSkillMarkdown(name, input.description, input.body)
    writeFileSync(skillPath, content, 'utf-8')

    this.reload()
    const created = this.getRegistry().get(name)
    if (!created) {
      throw new Error(`创建后未能加载技能：${name}`)
    }
    return toSkillSummary(created)
  }

  /**
   * 删除技能（仅 global / project）
   */
  delete(name: string): void {
    const skill = this.getRegistry().get(name)
    if (!skill) {
      throw new Error(`技能不存在：${name}`)
    }
    if (skill.source === 'builtin' || skill.source === 'third_party_claude') {
      throw new Error(`无法删除来源为 ${skill.source} 的技能`)
    }

    rmSync(skill.directory, { recursive: true, force: true })
    delete this.skillState[name]
    this.saveSkillState()
    this.reload()
  }

  /**
   * 切换 model 调用开关（持久化）
   */
  toggle(name: string, enabled: boolean): SkillSummary {
    const skill = this.getRegistry().get(name)
    if (!skill) {
      throw new Error(`技能不存在：${name}`)
    }
    if (skill.invalid) {
      throw new Error(`技能无效，无法切换：${skill.invalidReason}`)
    }

    this.skillState[name] = enabled
    this.saveSkillState()
    skill.enabled = enabled

    return toSkillSummary(skill)
  }

  /**
   * 从 zip 或 https URL 导入技能
   */
  async import(input: SkillImportInput): Promise<SkillSummary> {
    if (!input.zipPath && !input.url) {
      throw new Error('请提供 zip 路径或 https URL')
    }
    if (input.zipPath && input.url) {
      throw new Error('zip 路径与 URL 不能同时指定')
    }

    const temp = createTempSkillDir('import')
    let zipPath = input.zipPath

    try {
      if (input.url) {
        zipPath = join(temp.dir, 'download.zip')
        await downloadHttpsToFile(input.url, zipPath)
      }

      if (!zipPath || !existsSync(zipPath)) {
        throw new Error('zip 文件不存在')
      }
      if (!isZipPath(zipPath)) {
        throw new Error('仅支持 .zip 格式')
      }

      const extractDir = join(temp.dir, 'extracted')
      await extractZip(zipPath, extractDir)

      const skillRoot = findSkillRoot(extractDir)
      const { name } = validateSkillDirectory(skillRoot)

      const targetDir = join(this.resolveLocationDir(input.location), name)
      if (existsSync(targetDir)) {
        throw new Error(`技能「${name}」已存在，请先删除或更换名称`)
      }

      cpSync(skillRoot, targetDir, { recursive: true })

      this.reload()
      const imported = this.getRegistry().get(name)
      if (!imported) {
        throw new Error(`导入后未能加载技能：${name}`)
      }
      return toSkillSummary(imported)
    } finally {
      temp.cleanup()
    }
  }

  /**
   * 导出技能目录为 zip（与导入格式对称的 `<name>/` 单层包）。
   * 仅要求 SKILL.md 存在，不校验 frontmatter 有效性：导出的是磁盘原样，
   * 有效性由导入侧把关。
   */
  async export(name: string, destPath: string): Promise<string> {
    const skill = this.getRegistry().get(name)
    if (!skill) throw new Error(`技能不存在：${name}`)
    if (!existsSync(join(skill.directory, 'SKILL.md'))) {
      throw new Error(`技能「${name}」目录缺少 SKILL.md，无法导出`)
    }
    const zipPath = destPath.toLowerCase().endsWith('.zip') ? destPath : `${destPath}.zip`
    await createZipFromDirectory(skill.directory, zipPath, name)
    return zipPath
  }

  getReloadResult(): SkillReloadResult {
    const registry = this.getRegistry()
    return {
      count: registry.getLoader().listAll().length,
      errors: registry.getErrors().map(e => `${e.path}: ${e.message}`)
    }
  }

  /** 目录级模型预算投影（未按会话 profile 过滤） */
  getModelBudget(): SkillModelBudget {
    return {
      cap: MAX_CONTEXT_SKILLS,
      eligible: this.getRegistry().getContextProjection().eligible
    }
  }

  private resolveLocationDir(location: SkillCreateLocation): string {
    if (location === 'global') {
      mkdirSync(this.globalDir, { recursive: true })
      return this.globalDir
    }
    if (!this.workspaceRoot) {
      throw new Error('未选择工作区，无法创建项目级技能')
    }
    const projectDir = join(this.workspaceRoot, '.nova', 'skills')
    mkdirSync(projectDir, { recursive: true })
    return projectDir
  }

  private loadSkillState(): void {
    const statePath = join(this.novaHomeDir, SKILL_STATE_FILE)
    if (!existsSync(statePath)) {
      this.skillState = {}
      return
    }
    try {
      const raw = readFileSync(statePath, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, boolean>
      this.skillState = parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      this.skillState = {}
    }
  }

  private saveSkillState(): void {
    mkdirSync(this.novaHomeDir, { recursive: true })
    const statePath = join(this.novaHomeDir, SKILL_STATE_FILE)
    writeFileSync(statePath, JSON.stringify(this.skillState, null, 2), 'utf-8')
  }

  /** 将持久化开关应用到已加载 manifest */
  private applySkillState(): void {
    if (!this.registry) return
    for (const skill of this.registry.getLoader().listAll()) {
      if (!(skill.name in this.skillState)) {
        skill.enabled = skill.modelInvocable
      } else {
        skill.enabled = this.skillState[skill.name]!
      }
    }
  }
}

function buildSkillMarkdown(name: string, description: string, body: string): string {
  const trimmedBody = body.trim() || `# ${name}\n\n<!-- 在此编写技能正文 -->`
  return `---\nname: ${name}\ndescription: ${description}\nuser-invocable: true\n---\n\n${trimmedBody}\n`
}