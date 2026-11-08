/**
 * SkillService — 桌面端技能管理单例
 * 封装加载、CRUD、启停持久化与导入导出
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { SkillRegistry } from './SkillRegistry'
import { resolveBuiltinSkillsDir } from './SkillLoader'
import { createSkillId } from '../../shared/skills/identity'
import { describeThirdPartySources, resolveThirdPartySkillDirs } from './thirdPartySources'
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
  SkillReloadResult,
  SkillSummary,
  ThirdPartySkillSourceStatus
} from '../../shared/skills/types'

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const BODY_PREVIEW_LEN = 280

export interface SkillServiceOptions {
  /** Electron app.getAppPath；用于定位 builtin 目录 */
  getAppPath?: () => string
  /** 全局技能目录，默认 ~/.nova/skills */
  globalDir?: string
}

/** 将完整 manifest 转为 IPC 安全摘要 */
export function toSkillSummary(skill: SkillManifest, workspaceRoot?: string | null): SkillSummary {
  return {
    skillId: createSkillId(skill, workspaceRoot),
    name: skill.name,
    nameZh: skill.nameZh,
    description: skill.description,
    descriptionZh: skill.descriptionZh,
    source: skill.source,
    sourcePath: skill.sourcePath,
    userInvocable: skill.userInvocable,
    modelInvocable: skill.modelInvocable,
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

const SOURCE_LABELS: Record<string, string> = {
  builtin: '内置',
  global: '本地',
  project: '项目',
  third_party: '第三方'
}

/**
 * 把注册表的加载错误、来源遮蔽与模式限制投影为目录诊断。
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
      message: `技能「${name}」被高优先级来源覆盖，${SOURCE_LABELS[source] ?? source}版本未生效`,
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

  constructor(opts: SkillServiceOptions = {}) {
    this.getAppPath = opts.getAppPath
    this.globalDir = opts.globalDir ?? join(homedir(), '.nova', 'skills')
  }

  /** 切换工作区但推迟扫描，下次读取目录时按新工作区加载 */
  selectWorkspace(workspaceRoot: string | null): void {
    if (workspaceRoot === this.workspaceRoot) return
    this.workspaceRoot = workspaceRoot
    this.registry = null
  }

  /** 加载或切换工作区 */
  load(workspaceRoot?: string | null): SkillRegistry {
    if (workspaceRoot !== undefined) {
      this.workspaceRoot = workspaceRoot
    }
    return this.reload()
  }

  /** 按当前 workspace 重新扫描；用户已同意的第三方目录原地读取 */
  reload(): SkillRegistry {
    const builtinDir = resolveBuiltinSkillsDir(this.getAppPath)
    this.registry = SkillRegistry.load({
      workspaceRoot: this.workspaceRoot ?? undefined,
      builtinDir,
      globalDir: this.globalDir,
      thirdPartyDirs: this.thirdPartyDirs()
    })
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

  private thirdPartyDirs(): string[] {
    return resolveThirdPartySkillDirs(loadNovaSettings().thirdPartySkillSources, this.workspaceRoot)
  }

  /** 设置页展示用：各第三方来源的路径、是否存在与技能数 */
  getThirdPartySources(): ThirdPartySkillSourceStatus[] {
    return describeThirdPartySources(loadNovaSettings().thirdPartySkillSources, this.workspaceRoot)
  }

  /** 需要监听文件变化的技能根目录（不含只读的内置目录） */
  getWatchRoots(): string[] {
    const project = this.workspaceRoot ? [join(this.workspaceRoot, '.nova', 'skills')] : []
    return [this.globalDir, ...project, ...this.thirdPartyDirs()]
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
      .map(skill => toSkillSummary(skill, this.workspaceRoot))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  listUserInvocable(profile?: string): SkillSummary[] {
    return this.getRegistry()
      .listUserInvocable(profile)
      .map(skill => toSkillSummary(skill, this.workspaceRoot))
  }

  listForPilot(permittedIds: readonly string[]): SkillSummary[] {
    const registry = this.getRegistry()
    return registry.listUserInvocable('default')
      .filter(skill => registry.canInvokeInPilot(skill, permittedIds, this.workspaceRoot ?? undefined))
      .map(skill => toSkillSummary(skill, this.workspaceRoot))
  }

  get(name: string): SkillSummary | null {
    const skill = this.getRegistry().get(name)
    return skill ? toSkillSummary(skill, this.workspaceRoot) : null
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
    return toSkillSummary(created, this.workspaceRoot)
  }

  /**
   * 删除技能（仅 global / project）
   */
  delete(name: string): void {
    const skill = this.getRegistry().get(name)
    if (!skill) {
      throw new Error(`技能不存在：${name}`)
    }
    if (skill.source === 'builtin' || skill.source === 'third_party') {
      throw new Error(`无法删除来源为 ${skill.source} 的技能`)
    }

    rmSync(skill.directory, { recursive: true, force: true })
    this.reload()
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
      return toSkillSummary(imported, this.workspaceRoot)
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
}

function buildSkillMarkdown(name: string, description: string, body: string): string {
  const trimmedBody = body.trim() || `# ${name}\n\n<!-- 在此编写技能正文 -->`
  return `---\nname: ${name}\ndescription: ${description}\nuser-invocable: true\n---\n\n${trimmedBody}\n`
}