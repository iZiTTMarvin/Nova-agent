import { describe, it, expect } from 'vitest'
import { parseSkillMarkdown } from '../../../../src/runtime/skills/frontmatter'

const SAMPLE = `---
name: commit
description: Smart Git commit helper
user-invocable: true
disable-model-invocation: false
---

# Commit Skill
Do commits.
`

const baseOpts = {
  fallbackName: 'fallback',
  source: 'global' as const,
  sourcePath: '/tmp/SKILL.md',
  directory: '/tmp/commit'
}

describe('parseSkillMarkdown', () => {
  it('解析完整 frontmatter', () => {
    const m = parseSkillMarkdown(SAMPLE, baseOpts)
    expect(m.name).toBe('commit')
    expect(m.description).toBe('Smart Git commit helper')
    expect(m.userInvocable).toBe(true)
    expect(m.modelInvocable).toBe(true)
    expect(m.body).toContain('# Commit Skill')
    expect(m.source).toBe('global')
    expect(m.warnings).toEqual([])
  })

  it('无 frontmatter 降级为正文首段', () => {
    const m = parseSkillMarkdown('# no frontmatter\n\nFirst para.', baseOpts)
    expect(m.description).toContain('First para')
    expect(m.warnings.some(w => w.includes('frontmatter'))).toBe(true)
  })

  it('缺 description 且无正文段落则 invalid', () => {
    const raw = `---\nname: x\n---\n`
    const m = parseSkillMarkdown(raw, { ...baseOpts, fallbackName: 'x' })
    expect(m.invalid).toBe(true)
  })

  it('name 缺省时用目录名 fallback', () => {
    const raw = `---\ndescription: d\n---\nbody`
    expect(parseSkillMarkdown(raw, { ...baseOpts, fallbackName: 'my-skill' }).name).toBe('my-skill')
  })

  it('disable-model-invocation: true 禁止模型调用', () => {
    const raw = `---\nname: a\ndescription: d\ndisable-model-invocation: true\n---\n`
    expect(parseSkillMarkdown(raw, baseOpts).modelInvocable).toBe(false)
  })

  it('user-invocable: false', () => {
    const raw = `---\nname: a\ndescription: d\nuser-invocable: false\n---\n`
    expect(parseSkillMarkdown(raw, baseOpts).userInvocable).toBe(false)
  })

  it('description 超 340 字符产生 warning', () => {
    const long = 'a'.repeat(400)
    const raw = `---\nname: a\ndescription: ${long}\n---\n`
    const m = parseSkillMarkdown(raw, baseOpts)
    expect(m.description.length).toBe(340)
    expect(m.warnings.some(w => w.includes('340'))).toBe(true)
  })

  it('context: fork 映射 forkAgent', () => {
    const raw = `---\nname: a\ndescription: d\ncontext: fork\n---\n`
    expect(parseSkillMarkdown(raw, baseOpts).forkAgent).toBe(true)
  })

  it('非法 slug name 降级目录名', () => {
    const raw = `---\nname: Bad_Name\ndescription: d\n---\n`
    const m = parseSkillMarkdown(raw, { ...baseOpts, fallbackName: 'bad-name' })
    expect(m.name).toBe('bad-name')
    expect(m.warnings.some(w => w.includes('slug'))).toBe(true)
  })
})
