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
    }

    expect(loader.get('deep-research')!.description).toMatch(/调研|检索|结论/)
    expect(loader.get('code-review')!.description).toMatch(/审查|改动|git/)

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

    const deep = invokeSkill({
      input: '/deep-research 对比向量数据库选型',
      registry,
      templateContext: { workspacePath: 'D:/ws' }
    })
    expect(deep.kind).toBe('inject')
    if (deep.kind === 'inject') {
      expect(deep.assistantContent).toContain('D:/ws')
      expect(deep.assistantContent).toContain('brief')
      expect(deep.assistantContent).toContain('task')
      expect(deep.assistantContent).toContain('.nova/reports')
      expect(deep.userContent).toContain('请按上述')
      expect(deep.userContent).toContain('对比向量数据库选型')
      expect(deep.skillDirectory).toContain('deep-research')
    }

    const review = invokeSkill({
      input: '/code-review 关注权限边界',
      registry,
      templateContext: { workspacePath: 'D:/ws' }
    })
    expect(review.kind).toBe('inject')
    if (review.kind === 'inject') {
      expect(review.assistantContent).toContain('D:/ws')
      expect(review.assistantContent).toContain('git')
      expect(review.assistantContent).toContain('verdict')
      expect(review.assistantContent).toContain('.nova/reports')
      expect(review.userContent).toContain('关注权限边界')
      expect(review.skillDirectory).toContain('code-review')
    }
  })

  it('deep-research 指南覆盖规划、并行检索、汇总、复核与落盘语义', () => {
    const body = skillBody('deep-research')
    for (const token of [
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
    ]) {
      expect(body, `deep-research 缺少语义：${token}`).toContain(token)
    }
  })

  it('code-review 指南覆盖范围收集、只读审查、报告组织与落盘语义', () => {
    const body = skillBody('code-review')
    for (const token of [
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
    ]) {
      expect(body, `code-review 缺少语义：${token}`).toContain(token)
    }
  })
})
