/**
 * SkillRegistry — 在 SkillLoader 之上提供缓存查询 API
 * 对外保留 load / get / listForContext / listUserInvocable，并扩展 reload / errors / shadowed
 */
import { join } from 'path'
import { homedir } from 'os'
import { SkillLoader, resolveDevBuiltinDir, type SkillLoaderOptions } from './SkillLoader'
import type { LoadError, SkillManifest, SkillSource } from './types'

export interface SkillRegistryLoadOptions extends SkillLoaderOptions {
  /** 工作区根目录，自动解析 projectDir = <root>/.nova/skills */
  workspaceRoot?: string
  /** @deprecated 使用 projectDir 或 workspaceRoot */
  projectDir?: string
}

let warnedTruncation = false

export class SkillRegistry {
  private loader: SkillLoader
  private lastOpts: SkillRegistryLoadOptions = {}

  private constructor(loader: SkillLoader, opts: SkillRegistryLoadOptions) {
    this.loader = loader
    this.lastOpts = opts
  }

  /**
   * 扫描多源技能目录并构建注册表
   */
  static load(opts: SkillRegistryLoadOptions = {}): SkillRegistry {
    const projectDir =
      opts.projectDir ??
      (opts.workspaceRoot ? join(opts.workspaceRoot, '.nova', 'skills') : undefined)

    const loaderOpts: SkillLoaderOptions = {
      // builtin 仅显式传入时扫描（生产由 agentHandler 注入 app 路径；开发可传 resolveDevBuiltinDir()）
      builtinDir: opts.builtinDir,
      globalDir: opts.globalDir ?? join(homedir(), '.nova', 'skills'),
      projectDir,
      thirdPartyDir: opts.thirdPartyDir
    }

    const loader = SkillLoader.loadAll(loaderOpts)
    const all = loader.listAll()

    if (all.length > 30 && !warnedTruncation) {
      console.warn('[SkillRegistry] 技能超过 30 条，listForContext 将截断')
      warnedTruncation = true
    }

    return new SkillRegistry(loader, { ...opts, projectDir })
  }

  /** 使用上次选项重新加载 */
  reload(workspaceRoot?: string): SkillRegistry {
    const opts = { ...this.lastOpts }
    if (workspaceRoot) {
      opts.workspaceRoot = workspaceRoot
      opts.projectDir = join(workspaceRoot, '.nova', 'skills')
    }
    return SkillRegistry.load(opts)
  }

  /** 重置截断 warn 标志（测试用） */
  static resetWarnFlag(): void {
    warnedTruncation = false
  }

  get(name: string): SkillManifest | undefined {
    return this.loader.get(name)
  }

  getErrors(): LoadError[] {
    return this.loader.getErrors()
  }

  getShadowed(): Record<string, SkillSource> {
    return this.loader.getShadowed()
  }

  listForContext(profile?: string, opts?: { includeHidden?: boolean }): SkillManifest[] {
    return this.loader.listForContext(profile, opts)
  }

  listHidden(): SkillManifest[] {
    return this.loader.listHidden()
  }

  listUserInvocable(): SkillManifest[] {
    return this.loader.listUserInvocable()
  }

  /** 内部 loader 访问（测试 / 扩展） */
  getLoader(): SkillLoader {
    return this.loader
  }
}
