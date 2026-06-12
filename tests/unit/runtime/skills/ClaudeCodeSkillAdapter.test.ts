import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
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
})
