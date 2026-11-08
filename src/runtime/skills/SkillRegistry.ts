/**
 * SkillRegistry — 在 SkillLoader 之上提供缓存查询 API
 * 对外保留 load / get / listForContext / listUserInvocable，并扩展 reload / errors / shadowed
 */
import { join } from 'path'
import { homedir } from 'os'
import {
  SkillLoader,
  resolveDevBuiltinDir,
  type SkillLoaderOptions
} from './SkillLoader'
import type { LoadError, SkillManifest, SkillSource } from './types'
import { createSkillId } from '../../shared/skills/identity'

export interface SkillRegistryLoadOptions extends SkillLoaderOptions {
  /** 工作区根目录，自动解析 projectDir = <root>/.nova/skills */
  workspaceRoot?: string
  /** @deprecated 使用 projectDir 或 workspaceRoot */
  projectDir?: string
}

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
      thirdPartyDirs: opts.thirdPartyDirs
    }

    const loader = SkillLoader.loadAll(loaderOpts)

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

  get(name: string): SkillManifest | undefined {
    return this.loader.get(name)
  }

  isBuiltinPilotReference(name: string): boolean {
    if (name !== 'builtin:nova-pilot') return false
    const skill = this.loader.get(name)
    return skill?.source === 'builtin' && skill.name === 'nova-pilot' && !skill.invalid
  }

  getErrors(): LoadError[] {
    return this.loader.getErrors()
  }

  getShadowed(): Record<string, SkillSource> {
    return this.loader.getShadowed()
  }

  listForContext(profile?: string): SkillManifest[] {
    return this.loader.listForContext(profile)
  }

  listUserInvocable(profile?: string): SkillManifest[] {
    return this.loader.listUserInvocable().filter(skill => SkillLoader.isAgentAllowed(skill, profile))
  }

  canInvokeInPilot(skill: SkillManifest, permittedIds: readonly string[], workspaceRoot?: string): boolean {
    return skill.userInvocable && !skill.hidden && !skill.invalid &&
      SkillLoader.isAgentAllowed(skill, 'default') && SkillLoader.isAgentAllowed(skill, 'pilot') &&
      permittedIds.includes(createSkillId(skill, workspaceRoot ?? this.lastOpts.workspaceRoot))
  }

  /** 内部 loader 访问（测试 / 扩展） */
  getLoader(): SkillLoader {
    return this.loader
  }
}
