/**
 * resolveAgentTurnRoute 路由矩阵测试：覆盖每一行路由分类规则。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveAgentTurnRoute, routeRunKind, agentRoute } from '../../../../src/runtime/agent/turn'
import { SkillRegistry } from '../../../../src/runtime/skills/SkillRegistry'
import type { ContentBlock } from '../../../../src/runtime/model/types'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createRegistry(root: string, skills: Array<{ name: string; workflow?: string; forkAgent?: boolean }>): SkillRegistry {
  const skillsDir = join(root, 'skills')
  for (const s of skills) {
    const dir = join(skillsDir, s.name)
    mkdirSync(dir, { recursive: true })
    const lines = [
      '---',
      `name: ${s.name}`,
      `description: ${s.name} skill`,
      'user-invocable: true',
      ...(s.workflow ? [`workflow: ${s.workflow}`] : []),
      ...(s.forkAgent ? ['fork_agent: true'] : []),
      '---',
      `Body of ${s.name}.`
    ]
    writeFileSync(join(dir, 'SKILL.md'), lines.join('\n'))
  }
  return SkillRegistry.load({ globalDir: skillsDir })
}

function baseInput(overrides: Partial<Parameters<typeof resolveAgentTurnRoute>[0]> = {}) {
  return {
    content: '你好',
    mode: 'default' as const,
    skillRegistry: null,
    useUnifiedSkillDispatch: true,
    workspacePath: '/tmp/test',
    resumableXForge: false,
    ...overrides
  }
}

describe('resolveAgentTurnRoute 路由矩阵', () => {
  it('resumable XForge 不被新输入重新分类', () => {
    const route = resolveAgentTurnRoute(baseInput({
      content: '随便说点什么',
      resumableXForge: true
    }))
    expect(route.kind).toBe('xforge')
    expect(routeRunKind(route)).toBe('xforge')
  })

  it('ContentBlock[] 图片消息始终走 agent', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: '看这张图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } }
    ]
    const route = resolveAgentTurnRoute(baseInput({
      content: blocks,
      mode: 'compose'
    }))
    expect(route.kind).toBe('agent')
    expect(routeRunKind(route)).toBe('agent')
  })

  it('unified dispatch 关闭时走 agent', () => {
    const route = resolveAgentTurnRoute(baseInput({
      useUnifiedSkillDispatch: false
    }))
    expect(route.kind).toBe('agent')
    if (route.kind === 'agent') {
      expect(route.dispatch.kind).toBe('passthrough')
    }
  })

  it('无 skillRegistry 时走 agent', () => {
    const route = resolveAgentTurnRoute(baseInput({
      skillRegistry: null
    }))
    expect(route.kind).toBe('agent')
  })

  it('compose + passthrough → xforge', () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-route-'))
    roots.push(root)
    const registry = createRegistry(root, [])
    const route = resolveAgentTurnRoute(baseInput({
      content: '实现登录功能',
      mode: 'compose',
      skillRegistry: registry
    }))
    expect(route.kind).toBe('xforge')
    expect(routeRunKind(route)).toBe('xforge')
    if (route.kind === 'xforge') {
      expect(route.request).toBe('实现登录功能')
      expect(route.explicitFullDev).toBe(false)
    }
  })

  it('compose + /br-full-dev → xforge（explicitFullDev=true）', () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-route-'))
    roots.push(root)
    const registry = createRegistry(root, [{ name: 'br-full-dev', workflow: 'br-full-dev' }])
    const route = resolveAgentTurnRoute(baseInput({
      content: '/br-full-dev 实现登录',
      mode: 'compose',
      skillRegistry: registry
    }))
    expect(route.kind).toBe('xforge')
    expect(routeRunKind(route)).toBe('xforge')
    if (route.kind === 'xforge') {
      expect(route.request).toBe('实现登录')
      expect(route.explicitFullDev).toBe(true)
    }
  })

  it('non-compose + /br-full-dev → workflow / compose run', () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-route-'))
    roots.push(root)
    const registry = createRegistry(root, [{ name: 'br-full-dev', workflow: 'br-full-dev' }])
    const route = resolveAgentTurnRoute(baseInput({
      content: '/br-full-dev 实现登录',
      mode: 'default',
      skillRegistry: registry
    }))
    expect(route.kind).toBe('workflow')
    expect(routeRunKind(route)).toBe('compose')
    if (route.kind === 'workflow') {
      expect(route.scriptName).toBe('br-full-dev')
      expect(route.args).toBe('实现登录')
    }
  })

  it('compose + 其他 workflow skill → workflow / compose run（不是 xforge）', () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-route-'))
    roots.push(root)
    const registry = createRegistry(root, [{ name: 'legacy-flow', workflow: 'legacy-flow' }])
    const route = resolveAgentTurnRoute(baseInput({
      content: '/legacy-flow 继续旧编排',
      mode: 'compose',
      skillRegistry: registry
    }))
    expect(route.kind).toBe('workflow')
    expect(routeRunKind(route)).toBe('compose')
    if (route.kind === 'workflow') {
      expect(route.scriptName).toBe('legacy-flow')
    }
  })

  it('fork skill → skill_fork / agent run', () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-route-'))
    roots.push(root)
    const registry = createRegistry(root, [{ name: 'my-fork', forkAgent: true }])
    const route = resolveAgentTurnRoute(baseInput({
      content: '/my-fork 做点事',
      skillRegistry: registry
    }))
    expect(route.kind).toBe('skill_fork')
    expect(routeRunKind(route)).toBe('agent')
    if (route.kind === 'skill_fork') {
      expect(route.skill.name).toBe('my-fork')
      expect(route.args).toBe('做点事')
    }
  })

  it('inject skill → agent', () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-route-'))
    roots.push(root)
    const registry = createRegistry(root, [{ name: 'onboard' }])
    const route = resolveAgentTurnRoute(baseInput({
      content: '/onboard',
      skillRegistry: registry
    }))
    expect(route.kind).toBe('agent')
    expect(routeRunKind(route)).toBe('agent')
    if (route.kind === 'agent') {
      expect(route.dispatch.kind).toBe('inject')
    }
  })

  it('system_notice（未找到的 slash）→ agent', () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-route-'))
    roots.push(root)
    const registry = createRegistry(root, [])
    const route = resolveAgentTurnRoute(baseInput({
      content: '/nonexistent-skill',
      skillRegistry: registry
    }))
    expect(route.kind).toBe('agent')
    if (route.kind === 'agent') {
      expect(route.dispatch.kind).toBe('system_notice')
    }
  })

  it('普通文本 + default 模式 → agent passthrough', () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-route-'))
    roots.push(root)
    const registry = createRegistry(root, [])
    const route = resolveAgentTurnRoute(baseInput({
      content: '帮我写个函数',
      skillRegistry: registry
    }))
    expect(route.kind).toBe('agent')
    if (route.kind === 'agent') {
      expect(route.dispatch.kind).toBe('passthrough')
    }
  })
})

describe('routeRunKind 映射', () => {
  it('每种 route kind 映射到正确的 RunKind', () => {
    expect(routeRunKind({ kind: 'xforge', request: '', explicitFullDev: false })).toBe('xforge')
    expect(routeRunKind({ kind: 'workflow', scriptName: 'x', args: '' })).toBe('compose')
    expect(routeRunKind({ kind: 'skill_fork', skill: {} as never, args: '' })).toBe('agent')
    expect(routeRunKind(agentRoute())).toBe('agent')
  })
})

describe('agentRoute 工厂', () => {
  it('默认返回 passthrough dispatch', () => {
    const route = agentRoute()
    expect(route.kind).toBe('agent')
    if (route.kind === 'agent') {
      expect(route.dispatch.kind).toBe('passthrough')
    }
  })

  it('可传入自定义 dispatch', () => {
    const route = agentRoute({ kind: 'system_notice', text: '提示' })
    expect(route.kind).toBe('agent')
    if (route.kind === 'agent') {
      expect(route.dispatch.kind).toBe('system_notice')
    }
  })
})
