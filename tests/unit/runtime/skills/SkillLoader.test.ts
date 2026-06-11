import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SkillLoader } from '../../../../src/runtime/skills/SkillLoader'

function writeSkill(base: string, dirName: string, content: string): void {
  const dir = join(base, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), content)
}

const md = (name: string, desc: string, extra = '') =>
  `---\nname: ${name}\ndescription: ${desc}\n${extra}---\n# ${name}`

describe('SkillLoader', () => {
  let builtinDir: string
  let globalDir: string
  let projectDir: string

  beforeEach(() => {
    const ts = Date.now()
    builtinDir = join(tmpdir(), `nova-builtin-${ts}`)
    globalDir = join(tmpdir(), `nova-global-${ts}`)
    projectDir = join(tmpdir(), `nova-project-${ts}`)
    mkdirSync(builtinDir, { recursive: true })
    mkdirSync(globalDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(builtinDir, { recursive: true, force: true })
    rmSync(globalDir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('按优先级 project 覆盖 global', () => {
    writeSkill(globalDir, 'commit', md('commit', 'global'))
    writeSkill(projectDir, 'commit', md('commit', 'project'))
    const loader = SkillLoader.loadAll({ globalDir, projectDir })
    expect(loader.get('commit')?.description).toBe('project')
    expect(loader.getShadowed()['commit']).toBe('global')
  })

  it('builtin 被 global 覆盖并记录 shadow', () => {
    writeSkill(builtinDir, 'onboard', md('onboard', 'builtin'))
    writeSkill(globalDir, 'onboard', md('onboard', 'global'))
    const loader = SkillLoader.loadAll({ builtinDir, globalDir })
    expect(loader.get('onboard')?.description).toBe('global')
    expect(loader.getShadowed()['onboard']).toBe('builtin')
  })

  it('非法 manifest 入 errors 不中断扫描', () => {
    writeSkill(globalDir, 'bad', 'not yaml')
    writeSkill(globalDir, 'good', md('good', 'ok'))
    const loader = SkillLoader.loadAll({ globalDir })
    expect(loader.get('good')).toBeDefined()
    expect(loader.getErrors().length).toBeGreaterThan(0)
  })

  it('listForContext 过滤 modelInvocable 与 agent 域', () => {
    writeSkill(globalDir, 'a', md('a', 'd', 'disable-model-invocation: true\n'))
    writeSkill(globalDir, 'b', md('b', 'ok', 'agent: explore\n'))
    writeSkill(globalDir, 'c', md('c', 'ok'))
    const loader = SkillLoader.loadAll({ globalDir })
    expect(loader.listForContext('explore').map(s => s.name)).toEqual(['b', 'c'])
    expect(loader.listForContext('default').map(s => s.name)).toEqual(['c'])
  })

  it('listUserInvocable 过滤 user-invocable', () => {
    writeSkill(globalDir, 'a', md('a', 'd', 'user-invocable: false\n'))
    writeSkill(globalDir, 'b', md('b', 'ok'))
    const loader = SkillLoader.loadAll({ globalDir })
    expect(loader.listUserInvocable().map(s => s.name)).toEqual(['b'])
  })
})
