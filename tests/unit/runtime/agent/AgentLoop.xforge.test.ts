import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import type { ModelClient } from '../../../../src/runtime/model/ModelClient'
import { SkillRegistry } from '../../../../src/runtime/skills/SkillRegistry'

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

describe('AgentLoop native XForge dispatch', () => {
  it.each([
    ['实现登录功能', false, '实现登录功能'],
    ['/br-full-dev 实现登录功能', true, '实现登录功能']
  ])('compose 输入 %s 进入同一个 XForge runner', async (input, explicit, request) => {
    const root = mkdtempSync(join(tmpdir(), 'nova-agent-xforge-route-'))
    roots.push(root)
    const skills = join(root, 'skills')
    const skillDir = join(skills, 'br-full-dev')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), [
      '---',
      'name: br-full-dev',
      'description: full development',
      'user-invocable: true',
      'workflow: br-full-dev',
      '---',
      'Run full development.'
    ].join('\n'))
    const loop = new AgentLoop(neverCalledModel(), new EventBus())
    loop.setMode('compose')
    loop.setSkillRegistry(SkillRegistry.load({ globalDir: skills }))
    const runner = vi.fn(async () => ({ summary: 'XForge completed' }))
    loop.setXForgeRunner(runner)

    await loop.sendMessage(input)

    expect(runner).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ explicitFullDev: explicit })
    )
    loop.dispose()
  })
})
