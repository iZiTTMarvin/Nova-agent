import { describe, it, expect } from 'vitest'
import { parseSlashCommand, suggestSimilarSkills } from '../../../../src/runtime/skills/parseSlashCommand'
import { SkillRegistry } from '../../../../src/runtime/skills/SkillRegistry'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const md = (name: string, desc: string, extra = '') =>
  `---\nname: ${name}\ndescription: ${desc}\n${extra}---\nbody`

function makeRegistry(skills: Record<string, string>): SkillRegistry {
  const dir = join(tmpdir(), `slash-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(skills)) {
    const skillDir = join(dir, name)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), content)
  }
  const reg = SkillRegistry.load({ globalDir: dir, builtinDir: join(dir, 'empty-builtin') })
  return reg
}

describe('parseSlashCommand', () => {
  it('非 slash 输入 matched=false', () => {
    const reg = SkillRegistry.load({ globalDir: join(tmpdir(), `empty-${Date.now()}`), builtinDir: join(tmpdir(), `eb-${Date.now()}`) })
    const r = parseSlashCommand('hello', reg)
    expect(r.matched).toBe(false)
  })

  it('路径形式不算 slash', () => {
    const reg = makeRegistry({})
    const r = parseSlashCommand('/foo/bar/baz', reg)
    expect(r.matched).toBe(false)
  })

  it('找到 user-invocable skill', () => {
    const reg = makeRegistry({ onboard: md('onboard', 'guide') })
    const r = parseSlashCommand('/onboard', reg)
    expect(r.matched).toBe(true)
    expect(r.found).toBe(true)
    expect(r.skill?.name).toBe('onboard')
  })

  it('解析 args', () => {
    const reg = makeRegistry({ deploy: md('deploy', 'd') })
    const r = parseSlashCommand('/deploy staging --force', reg)
    expect(r.args).toBe('staging --force')
  })

  it('not_found 带相似推荐', () => {
    const reg = makeRegistry({
      'code-review': md('code-review', 'd'),
      commit: md('commit', 'd')
    })
    const r = parseSlashCommand('/code', reg)
    expect(r.reason).toBe('not_found')
    expect(r.suggestions.length).toBeGreaterThan(0)
  })

  it('not_user_invocable', () => {
    const reg = makeRegistry({ hidden: md('hidden', 'd', 'user-invocable: false\n') })
    const r = parseSlashCommand('/hidden', reg)
    expect(r.reason).toBe('not_user_invocable')
  })

  it('agent_not_allowed', () => {
    const reg = makeRegistry({ explore: md('explore', 'd', 'agent: explore\n') })
    const r = parseSlashCommand('/explore', reg, 'default')
    expect(r.reason).toBe('agent_not_allowed')
  })

  it('suggestSimilarSkills 最多 3 条且优先子串匹配', () => {
    const s = suggestSimilarSkills('rev', ['review', 'code-review', 'revert', 'other'], 3)
    expect(s.length).toBeLessThanOrEqual(3)
    expect(s).toContain('code-review')
  })
})
