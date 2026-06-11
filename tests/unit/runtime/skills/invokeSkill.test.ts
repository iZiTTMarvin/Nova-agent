import { describe, it, expect } from 'vitest'
import { invokeSkill } from '../../../../src/runtime/skills/invokeSkill'
import { SkillRegistry } from '../../../../src/runtime/skills/SkillRegistry'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const md = (name: string, body: string, extra = '') =>
  `---\nname: ${name}\ndescription: d\n${extra}---\n${body}`

function registryWith(skills: Record<string, string>): SkillRegistry {
  const dir = join(tmpdir(), `invoke-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(skills)) {
    const d = join(dir, name)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'SKILL.md'), content)
  }
  return SkillRegistry.load({ globalDir: dir, builtinDir: join(dir, 'b') })
}

describe('invokeSkill', () => {
  it('非 slash → passthrough', () => {
    const reg = registryWith({})
    expect(invokeSkill({ input: 'hello', registry: reg }).kind).toBe('passthrough')
  })

  it('not_found → system_notice', () => {
    const reg = registryWith({})
    const r = invokeSkill({ input: '/missing', registry: reg })
    expect(r.kind).toBe('system_notice')
    if (r.kind === 'system_notice') {
      expect(r.text).toContain('未找到')
    }
  })

  it('not_user_invocable → system_notice', () => {
    const reg = registryWith({ x: md('x', 'b', 'user-invocable: false\n') })
    const r = invokeSkill({ input: '/x', registry: reg })
    expect(r.kind).toBe('system_notice')
  })

  it('inject 展开 body', () => {
    const reg = registryWith({ onboard: md('onboard', 'Do onboard <%= workspacePath %>') })
    const r = invokeSkill({
      input: '/onboard',
      registry: reg,
      templateContext: { workspacePath: '/ws' }
    })
    expect(r.kind).toBe('inject')
    if (r.kind === 'inject') {
      expect(r.assistantContent).toContain('/ws')
      expect(r.userContent).toContain('请按上述')
    }
  })

  it('forkAgent → fork', () => {
    const reg = registryWith({ deploy: md('deploy', 'deploy', 'context: fork\n') })
    const r = invokeSkill({ input: '/deploy prod', registry: reg })
    expect(r.kind).toBe('fork')
    if (r.kind === 'fork') {
      expect(r.args).toBe('prod')
    }
  })
})
