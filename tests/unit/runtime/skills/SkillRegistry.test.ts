import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SkillRegistry } from '../../../../src/runtime/skills/SkillRegistry'
import { invokeSkillForTool } from '../../../../src/runtime/skills/invokeSkill'

function writeSkill(base: string, dirName: string, content: string): void {
  const dir = join(base, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), content)
}

describe('SkillRegistry', () => {
  let globalDir: string
  let projectDir: string

  beforeEach(() => {
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

  it('技能再多也全量进入模型上下文，按名称固定排序', () => {
    for (let i = 0; i < 35; i++) {
      writeSkill(globalDir, `s${i}`, md(`s${i}`, `d${i}`))
    }
    const reg = SkillRegistry.load({ globalDir, ...noBuiltin })
    const names = reg.listForContext().map(s => s.name)
    expect(names).toHaveLength(35)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
  })

  it('目录不存在时不崩溃', () => {
    const reg = SkillRegistry.load({ globalDir: join(tmpdir(), 'nonexistent-nova-skills'), ...noBuiltin })
    expect(reg.listForContext()).toEqual([])
  })

  it('受保护引用始终返回真实内置正文与附件目录，普通同名覆盖仍生效', () => {
    const builtinDir = join(globalDir, 'builtin')
    const thirdPartyDir = join(globalDir, 'third-party')
    writeSkill(builtinDir, 'nova-pilot', `---\nname: nova-pilot\ndescription: pilot\nhidden: true\nuser-invocable: false\n---\nRead <%= skillDirectory %>/workflows/general.md`)
    for (const sourceDir of [thirdPartyDir, globalDir, projectDir]) {
      writeSkill(sourceDir, 'nova-pilot', md('nova-pilot', 'override'))
    }
    const reg = SkillRegistry.load({ builtinDir, globalDir, projectDir, thirdPartyDirs: [thirdPartyDir] })
    expect(reg.get('nova-pilot')?.source).toBe('project')
    const result = invokeSkillForTool('builtin:nova-pilot', 'task', reg)
    expect(result.success).toBe(true)
    expect(result.skill?.source).toBe('builtin')
    expect(result.skill?.directory).toBe(join(builtinDir, 'nova-pilot'))
    expect(result.output).toContain(`${join(builtinDir, 'nova-pilot')}/workflows/general.md`)
  })

  it('缺少真正内置项时不接受伪造的内部名称', () => {
    writeSkill(projectDir, 'fake', md('builtin:nova-pilot', 'forged'))
    const reg = SkillRegistry.load({ projectDir, globalDir, ...noBuiltin })
    expect(invokeSkillForTool('builtin:nova-pilot', 'task', reg)).toMatchObject({
      success: false, output: ''
    })
  })
})
