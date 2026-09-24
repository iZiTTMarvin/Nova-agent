import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  syncClaudeCodeSkills,
  resolveClaudeSkillsCacheDir
} from '../../../../src/runtime/skills/ClaudeCodeSkillAdapter'
import { SkillLoader } from '../../../../src/runtime/skills/SkillLoader'
import { saveNovaSettings } from '../../../../src/runtime/settings/novaSettings'

const md = (name: string, desc: string) =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}`

describe('ClaudeCodeSkillAdapter', () => {
  let novaHome: string
  let claudeGlobal: string
  let claudeProject: string
  let workspace: string
  let originalHome: string | undefined

  beforeEach(() => {
    const ts = Date.now()
    novaHome = join(tmpdir(), `nova-claude-home-${ts}`)
    claudeGlobal = join(tmpdir(), `nova-claude-global-${ts}`, '.claude', 'skills')
    claudeProject = join(tmpdir(), `nova-claude-ws-${ts}`)
    workspace = claudeProject

    mkdirSync(join(claudeGlobal, 'code-review'), { recursive: true })
    writeFileSync(
      join(claudeGlobal, 'code-review', 'SKILL.md'),
      md('code-review', 'Claude global review')
    )

    mkdirSync(join(workspace, '.claude', 'skills', 'deploy'), { recursive: true })
    writeFileSync(
      join(workspace, '.claude', 'skills', 'deploy', 'SKILL.md'),
      md('deploy', 'Claude project deploy')
    )

    originalHome = process.env.USERPROFILE
    process.env.USERPROFILE = join(tmpdir(), `nova-fake-user-${ts}`)
    mkdirSync(process.env.USERPROFILE, { recursive: true })
    mkdirSync(join(process.env.USERPROFILE, '.claude', 'skills', 'code-review'), { recursive: true })
    writeFileSync(
      join(process.env.USERPROFILE, '.claude', 'skills', 'code-review', 'SKILL.md'),
      md('code-review', 'Claude global review')
    )

    saveNovaSettings({ loadThirdPartySkills: true })
  })

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env.USERPROFILE = originalHome
    }
    rmSync(novaHome, { recursive: true, force: true })
    rmSync(claudeGlobal, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
    if (process.env.USERPROFILE?.includes('nova-fake-user')) {
      rmSync(process.env.USERPROFILE, { recursive: true, force: true })
    }
  })

  it('开关开启时同步全局与项目 skill 到缓存', () => {
    const result = syncClaudeCodeSkills({
      enabled: true,
      workspaceRoot: workspace,
      novaHomeDir: novaHome
    })

    expect(result).toBeDefined()
    const cacheDir = result!.cacheDir
    expect(existsSync(join(cacheDir, 'code-review', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(cacheDir, 'deploy', 'SKILL.md'))).toBe(true)

    const loader = SkillLoader.loadAll({ thirdPartyDir: cacheDir })
    expect(loader.get('code-review')?.source).toBe('third_party_claude')
    expect(loader.get('deploy')?.description).toBe('Claude project deploy')
  })

  it('开关关闭时不返回缓存目录', () => {
    const result = syncClaudeCodeSkills({
      enabled: false,
      workspaceRoot: workspace,
      novaHomeDir: novaHome
    })
    expect(result).toBeUndefined()
  })

  it('项目级 skill 覆盖全局同名项', () => {
    mkdirSync(join(workspace, '.claude', 'skills', 'code-review'), { recursive: true })
    writeFileSync(
      join(workspace, '.claude', 'skills', 'code-review', 'SKILL.md'),
      md('code-review', 'project override')
    )

    const result = syncClaudeCodeSkills({
      enabled: true,
      workspaceRoot: workspace,
      novaHomeDir: novaHome
    })

    const content = readFileSync(
      join(result!.cacheDir, 'code-review', 'SKILL.md'),
      'utf-8'
    )
    expect(content).toContain('project override')
  })

  it('缓存目录路径符合 ~/.nova/imported/claude-skills', () => {
    expect(resolveClaudeSkillsCacheDir(novaHome)).toBe(
      join(novaHome, 'imported', 'claude-skills')
    )
  })

  it('源未变更时二次同步零拷贝（启动路径不因技能数量变慢）', () => {
    const first = syncClaudeCodeSkills({
      enabled: true,
      workspaceRoot: workspace,
      novaHomeDir: novaHome
    })
    expect(first!.syncedCount).toBeGreaterThan(0)

    const second = syncClaudeCodeSkills({
      enabled: true,
      workspaceRoot: workspace,
      novaHomeDir: novaHome
    })
    expect(second!.syncedCount).toBe(0)
    expect(existsSync(join(second!.cacheDir, 'code-review', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(second!.cacheDir, 'deploy', 'SKILL.md'))).toBe(true)
  })

  it('源技能删除后缓存不残留', () => {
    const first = syncClaudeCodeSkills({
      enabled: true,
      workspaceRoot: workspace,
      novaHomeDir: novaHome
    })
    expect(existsSync(join(first!.cacheDir, 'deploy', 'SKILL.md'))).toBe(true)

    rmSync(join(workspace, '.claude', 'skills', 'deploy'), { recursive: true, force: true })

    const second = syncClaudeCodeSkills({
      enabled: true,
      workspaceRoot: workspace,
      novaHomeDir: novaHome
    })
    expect(existsSync(join(second!.cacheDir, 'deploy'))).toBe(false)
    expect(existsSync(join(second!.cacheDir, 'code-review', 'SKILL.md'))).toBe(true)
  })

  it('工作区切换后同名技能换源重建（项目覆盖版本被全局版本替换）', () => {
    mkdirSync(join(workspace, '.claude', 'skills', 'code-review'), { recursive: true })
    writeFileSync(
      join(workspace, '.claude', 'skills', 'code-review', 'SKILL.md'),
      md('code-review', 'project override')
    )
    const projectRun = syncClaudeCodeSkills({
      enabled: true,
      workspaceRoot: workspace,
      novaHomeDir: novaHome
    })
    expect(
      readFileSync(join(projectRun!.cacheDir, 'code-review', 'SKILL.md'), 'utf-8')
    ).toContain('project override')

    const otherWorkspace = join(tmpdir(), `nova-claude-ws-other-${Date.now()}`)
    const globalRun = syncClaudeCodeSkills({
      enabled: true,
      workspaceRoot: otherWorkspace,
      novaHomeDir: novaHome
    })
    expect(
      readFileSync(join(globalRun!.cacheDir, 'code-review', 'SKILL.md'), 'utf-8')
    ).toContain('Claude global review')

    rmSync(otherWorkspace, { recursive: true, force: true })
  })

  it('源 SKILL.md 更新后按 mtime 触发重拷', () => {
    syncClaudeCodeSkills({
      enabled: true,
      workspaceRoot: workspace,
      novaHomeDir: novaHome
    })

    const sourceSkill = join(workspace, '.claude', 'skills', 'deploy', 'SKILL.md')
    writeFileSync(sourceSkill, md('deploy', 'deploy v2'))
    const future = new Date(Date.now() + 60_000)
    utimesSync(sourceSkill, future, future)

    const updated = syncClaudeCodeSkills({
      enabled: true,
      workspaceRoot: workspace,
      novaHomeDir: novaHome
    })
    expect(updated!.syncedCount).toBe(1)
    expect(readFileSync(join(updated!.cacheDir, 'deploy', 'SKILL.md'), 'utf-8')).toContain(
      'deploy v2'
    )
  })

  it('附属文件单独更新也触发重拷（无需触碰 SKILL.md）', () => {
    syncClaudeCodeSkills({
      enabled: true,
      workspaceRoot: workspace,
      novaHomeDir: novaHome
    })

    mkdirSync(join(workspace, '.claude', 'skills', 'deploy', 'scripts'), { recursive: true })
    const attachment = join(workspace, '.claude', 'skills', 'deploy', 'scripts', 'run.sh')
    writeFileSync(attachment, 'echo v2')
    const future = new Date(Date.now() + 60_000)
    utimesSync(attachment, future, future)

    const updated = syncClaudeCodeSkills({
      enabled: true,
      workspaceRoot: workspace,
      novaHomeDir: novaHome
    })
    expect(updated!.syncedCount).toBe(1)
    expect(existsSync(join(updated!.cacheDir, 'deploy', 'scripts', 'run.sh'))).toBe(true)
  })
})
