/** 内置 deep-research / code-review skill：发现、调用与指南完整性。 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { SkillLoader } from '../../../../src/runtime/skills/SkillLoader'
import { SkillRegistry } from '../../../../src/runtime/skills/SkillRegistry'
import { invokeSkill } from '../../../../src/runtime/skills/invokeSkill'

const builtinSkillsDir = join(process.cwd(), '.nova', 'skills')

function loadBuiltin(): SkillLoader {
  return SkillLoader.loadAll({
    builtinDir: builtinSkillsDir,
    globalDir: join(builtinSkillsDir, '__no-global__'),
    projectDir: join(builtinSkillsDir, '__no-project__')
  })
}

function skillBody(name: string): string {
  const path = join(builtinSkillsDir, name, 'SKILL.md')
  expect(existsSync(path), `缺少内置技能 ${name}`).toBe(true)
  return readFileSync(path, 'utf8')
}

describe('deep-research / code-review 内置 skill', () => {
  it('可被 SkillLoader 发现且对用户与模型均可调用', () => {
    const loader = loadBuiltin()
    const names = ['deep-research', 'code-review'] as const

    for (const name of names) {
      const skill = loader.get(name)
      expect(skill, `未发现技能 ${name}`).toBeDefined()
      expect(skill!.invalid).toBeFalsy()
      expect(skill!.userInvocable).toBe(true)
      expect(skill!.modelInvocable).toBe(true)
      expect(skill!.hidden).toBeFalsy()
      expect(skill!.description.trim().length).toBeGreaterThan(0)
    }

    const userNames = loader.listUserInvocable().map((s) => s.name)
    const modelNames = loader.listForContext().map((s) => s.name)
    expect(userNames).toEqual(expect.arrayContaining(names))
    expect(modelNames).toEqual(expect.arrayContaining(names))
  })

  it('slash 调用注入展开后的指南正文', () => {
    const registry = SkillRegistry.load({
      builtinDir: builtinSkillsDir,
      globalDir: join(builtinSkillsDir, '__no-global__')
    })

    for (const name of ['deep-research', 'code-review'] as const) {
      const result = invokeSkill({
        input: `/${name} 示例请求`,
        registry,
        templateContext: { workspacePath: 'D:/ws' }
      })
      expect(result.kind).toBe('inject')
      if (result.kind !== 'inject') return
      expect(result.assistantContent.length).toBeGreaterThan(100)
      expect(result.assistantContent).toContain('D:/ws')
      expect(result.userContent).toContain('请按上述')
      expect(result.userContent).toContain('示例请求')
      expect(result.skillDirectory).toContain(name)
    }
  })

  it('deep-research 指南覆盖规划、并行检索、汇总、复核与落盘语义', () => {
    const body = skillBody('deep-research')
    const required = [
      'brief',
      'research',
      'synthesize',
      'review',
      'task',
      'web_search',
      '子问题',
      '来源',
      '不修改',
      '.nova/reports'
    ]
    for (const token of required) {
      expect(body, `deep-research 缺少语义：${token}`).toContain(token)
    }
  })

  it('code-review 指南覆盖范围收集、只读审查、报告组织与落盘语义', () => {
    const body = skillBody('code-review')
    const required = [
      'git',
      'diff',
      '只读',
      '正确性',
      '架构',
      '安全',
      'verdict',
      'findings',
      '不修改',
      '.nova/reports'
    ]
    for (const token of required) {
      expect(body, `code-review 缺少语义：${token}`).toContain(token)
    }
  })
})
