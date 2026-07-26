import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import type { ModelClient } from '../../../../src/runtime/model/ModelClient'
import { SkillRegistry } from '../../../../src/runtime/skills/SkillRegistry'
import { resolveAgentTurnRoute } from '../../../../src/runtime/agent/turn'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function neverCalledModel(): ModelClient {
  return {
    async *chat() { throw new Error('model should not be called before native XForge runner') },
    updateConfig() {}
  }
}

function createSkillRegistry(root: string, name: string, workflow: string): SkillRegistry {
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

describe('AgentLoop native XForge dispatch', () => {
  it.each([
    ['实现登录功能', false, '实现登录功能'],
    ['/br-full-dev 实现登录功能', true, '实现登录功能']
  ])('compose 输入 %s 进入同一个 XForge runner', async (input, explicit, request) => {
    const root = mkdtempSync(join(tmpdir(), 'nova-agent-xforge-route-'))
    roots.push(root)
    const registry = createSkillRegistry(root, 'br-full-dev', 'br-full-dev')
    const loop = new AgentLoop(neverCalledModel(), new EventBus())
    loop.setMode('compose')
    const runner = vi.fn(async () => ({ summary: 'XForge completed' }))
    loop.setXForgeRunner(runner)

    const route = resolveAgentTurnRoute({
      content: input,
      mode: 'compose',
      skillRegistry: registry,
      useUnifiedSkillDispatch: true,
      workspacePath: root,
      resumableXForge: false,
    })
    await loop.sendMessage(input, route)

    expect(runner).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ explicitFullDev: explicit })
    )
    loop.dispose()
  })

  it('显式旧 workflow skill 仍可进入 workflowRunner，不依赖自然语言三档路由', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-agent-legacy-workflow-'))
    roots.push(root)
    const registry = createSkillRegistry(root, 'legacy-flow', 'legacy-flow')
    const loop = new AgentLoop(neverCalledModel(), new EventBus())
    loop.setMode('compose')
    const runner = vi.fn(async () => ({ summary: 'legacy completed' }))
    loop.setWorkflowRunner(runner)

    const route = resolveAgentTurnRoute({
      content: '/legacy-flow 继续旧编排',
      mode: 'compose',
      skillRegistry: registry,
      useUnifiedSkillDispatch: true,
      workspacePath: root,
      resumableXForge: false,
    })
    await loop.sendMessage('/legacy-flow 继续旧编排', route)

    expect(runner).toHaveBeenCalledWith(
      'legacy-flow',
      '继续旧编排',
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) })
    )
    loop.dispose()
  })
})

describe('AgentLoop route 执行能力 fail-closed', () => {
  it('xforge route 缺少 runner 时抛错，且不产生任何轮次副作用', async () => {
    const loop = new AgentLoop(neverCalledModel(), new EventBus())
    const events: Array<{ type: string }> = []
    loop.getEventBus().on(e => events.push(e))

    const route = { kind: 'xforge' as const, request: 'x', explicitFullDev: false }
    await expect(loop.sendMessage('x', route)).rejects.toThrow(/xforgeRunner/)

    // 副作用前校验：未进入 running，未发 message_start，状态保持 idle
    expect(loop.getState()).toBe('idle')
    expect(events.some(e => e.type === 'message_start')).toBe(false)
    loop.dispose()
  })

  it('workflow route 缺少 runner 时抛错', async () => {
    const loop = new AgentLoop(neverCalledModel(), new EventBus())
    const route = { kind: 'workflow' as const, scriptName: 's', args: '' }
    await expect(loop.sendMessage('/s', route)).rejects.toThrow(/workflowRunner/)
    expect(loop.getState()).toBe('idle')
    loop.dispose()
  })

  it('skill_fork route 缺少 deps 时抛错', async () => {
    const loop = new AgentLoop(neverCalledModel(), new EventBus())
    const route = { kind: 'skill_fork' as const, skill: { name: 'f' } as never, args: '' }
    await expect(loop.sendMessage('/f', route)).rejects.toThrow(/skillForkDeps/)
    expect(loop.getState()).toBe('idle')
    loop.dispose()
  })
})
