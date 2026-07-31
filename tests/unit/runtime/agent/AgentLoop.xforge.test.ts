import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillRegistry } from '../../../../src/runtime/skills/SkillRegistry'
import { resolveAgentTurnRoute } from '../../../../src/runtime/agent/turn'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function createSkillRegistry(
  root: string,
  name: string,
  workflow: string
): SkillRegistry {
  const skills = join(root, 'skills')
  const skillDir = join(skills, name)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${name} skill`,
    'user-invocable: true',
    `workflow: ${workflow}`,
    '---',
    `Run ${name}.`
  ].join('\n'))
  return SkillRegistry.load({ globalDir: skills })
}

describe('compose 意图路由', () => {
  it('普通 compose 输入进入 AgentLoop 的 agent route', () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-agent-compose-route-'))
    roots.push(root)
    const registry = createSkillRegistry(root, 'br-full-dev', 'br-full-dev')

    const route = resolveAgentTurnRoute({
      content: '实现登录功能',
      mode: 'compose',
      skillRegistry: registry,
      useUnifiedSkillDispatch: true,
      workspacePath: root
    })

    expect(route).toEqual({ kind: 'agent', dispatch: { kind: 'passthrough' } })
  })

  it('workflow slash 输入不会绕过 AgentLoop', () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-agent-workflow-route-'))
    roots.push(root)
    const registry = createSkillRegistry(root, 'legacy-flow', 'legacy-flow')

    const route = resolveAgentTurnRoute({
      content: '/legacy-flow 继续',
      mode: 'compose',
      skillRegistry: registry,
      useUnifiedSkillDispatch: true,
      workspacePath: root
    })

    expect(route).toEqual({ kind: 'agent', dispatch: { kind: 'passthrough' } })
  })
})
