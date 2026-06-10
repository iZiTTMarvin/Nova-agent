import { describe, it, expect } from 'vitest'
import { parseSkillMarkdown } from '../../../../src/runtime/skills/SkillManifest'

const SAMPLE = `---
name: commit
description: Smart Git commit helper
user-invocable: true
disable-model-invocation: false
---

# Commit Skill
Do commits.
`

describe('parseSkillMarkdown', () => {
  it('解析完整 frontmatter', () => {
    const m = parseSkillMarkdown(SAMPLE, 'fallback')
    expect(m?.name).toBe('commit')
    expect(m?.description).toBe('Smart Git commit helper')
    expect(m?.userInvocable).toBe(true)
    expect(m?.modelInvocable).toBe(true)
    expect(m?.body).toContain('# Commit Skill')
  })

  it('无 frontmatter 返回 null', () => {
    expect(parseSkillMarkdown('# no frontmatter', 'x')).toBeNull()
  })

  it('缺 description 返回 null', () => {
    const raw = `---\nname: x\n---\nbody`
    expect(parseSkillMarkdown(raw, 'x')).toBeNull()
  })

  it('name 缺省时用目录名 fallback', () => {
    const raw = `---\ndescription: d\n---\nbody`
    expect(parseSkillMarkdown(raw, 'my-skill')?.name).toBe('my-skill')
  })

  it('disable-model-invocation: true 禁止模型调用', () => {
    const raw = `---\nname: a\ndescription: d\ndisable-model-invocation: true\n---\n`
    expect(parseSkillMarkdown(raw, 'a')?.modelInvocable).toBe(false)
  })

  it('user-invocable: false', () => {
    const raw = `---\nname: a\ndescription: d\nuser-invocable: false\n---\n`
    expect(parseSkillMarkdown(raw, 'a')?.userInvocable).toBe(false)
  })
})
