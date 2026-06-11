import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SkillRegistry } from '../../../../src/runtime/skills/SkillRegistry'

function writeSkill(base: string, dirName: string, content: string): void {
  const dir = join(base, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), content)
}

describe('SkillRegistry', () => {
  let globalDir: string
  let projectDir: string

  beforeEach(() => {
    SkillRegistry.resetWarnFlag()
    globalDir = join(tmpdir(), `nova-skills-g-${Date.now()}`)
    projectDir = join(tmpdir(), `nova-skills-p-${Date.now()}`)
    mkdirSync(globalDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(globalDir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  })

  const md = (name: string, desc: string) => `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}`
  const noBuiltin = { builtinDir: join(tmpdir(), `nova-no-builtin-${Date.now()}`) }

  it('扫描全局技能目录', () => {
    writeSkill(globalDir, 'commit', md('commit', 'git commit'))
    const reg = SkillRegistry.load({ globalDir, ...noBuiltin })
    expect(reg.get('commit')?.description).toBe('git commit')
  })

  it('扫描项目技能目录', () => {
    writeSkill(projectDir, 'lint', md('lint', 'lint helper'))
    const reg = SkillRegistry.load({ globalDir, projectDir, ...noBuiltin })
    expect(reg.get('lint')).toBeDefined()
  })

  it('项目级覆盖全局同名技能', () => {
    writeSkill(globalDir, 'commit', md('commit', 'global'))
    writeSkill(projectDir, 'commit', md('commit', 'project'))
    const reg = SkillRegistry.load({ globalDir, projectDir, ...noBuiltin })
    expect(reg.get('commit')?.description).toBe('project')
  })

  it('listForContext 只返回 modelInvocable', () => {
    writeSkill(globalDir, 'a', `---\nname: a\ndescription: d\ndisable-model-invocation: true\n---\n`)
    writeSkill(globalDir, 'b', md('b', 'ok'))
    const reg = SkillRegistry.load({ globalDir, ...noBuiltin })
    expect(reg.listForContext().map(s => s.name)).toEqual(['b'])
  })

  it('listUserInvocable 过滤 user-invocable', () => {
    writeSkill(globalDir, 'a', `---\nname: a\ndescription: d\nuser-invocable: false\n---\n`)
    writeSkill(globalDir, 'b', md('b', 'ok'))
    const reg = SkillRegistry.load({ globalDir, ...noBuiltin })
    expect(reg.listUserInvocable().map(s => s.name)).toEqual(['b'])
  })

  it('非法 manifest 记入 errors 不影响其他技能加载', () => {
    writeSkill(globalDir, 'bad', 'not yaml frontmatter')
    writeSkill(globalDir, 'good', md('good', 'ok'))
    const reg = SkillRegistry.load({ globalDir, ...noBuiltin })
    expect(reg.get('good')).toBeDefined()
    expect(reg.getErrors().length).toBeGreaterThan(0)
  })

  it('30 条上限截断', () => {
    for (let i = 0; i < 35; i++) {
      writeSkill(globalDir, `s${i}`, md(`s${i}`, `d${i}`))
    }
    const reg = SkillRegistry.load({ globalDir, ...noBuiltin })
    expect(reg.listForContext().length).toBe(30)
  })

  it('目录不存在时不崩溃', () => {
    const reg = SkillRegistry.load({ globalDir: join(tmpdir(), 'nonexistent-nova-skills'), ...noBuiltin })
    expect(reg.listForContext()).toEqual([])
  })
})
