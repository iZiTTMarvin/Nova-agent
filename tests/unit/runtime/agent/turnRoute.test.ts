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
import { createSkillId } from '../../../../src/shared/skills/identity'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createRegistry(root: string, skills: Array<{ name: string; forkAgent?: boolean }>): SkillRegistry {
  const skillsDir = join(root, 'skills')
  for (const s of skills) {
    const dir = join(skillsDir, s.name)
    mkdirSync(dir, { recursive: true })
    const lines = [
      '---',
      `name: ${s.name}`,
      `description: ${s.name} skill`,
      'user-invocable: true',
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
    workspacePath: '/tmp/test',
    ...overrides
  }
}

describe('resolveAgentTurnRoute 路由矩阵', () => {
  it('ContentBlock[] 图片消息始终走 agent', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: '看这张图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } }
    ]
    const route = resolveAgentTurnRoute(baseInput({
      content: blocks,
      mode: 'pilot'
    }))
    expect(route.kind).toBe('agent')
    expect(routeRunKind(route)).toBe('agent')
  })

  it('无 skillRegistry 时走 agent', () => {
    const route = resolveAgentTurnRoute(baseInput({
      skillRegistry: null
    }))
    expect(route.kind).toBe('agent')
  })

  it('pilot + passthrough → agent', () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-route-'))
    roots.push(root)
    const registry = createRegistry(root, [])
    const route = resolveAgentTurnRoute(baseInput({
      content: '实现登录功能',
      mode: 'pilot',
      skillRegistry: registry
    }))
    expect(route).toEqual({ kind: 'agent', dispatch: { kind: 'passthrough' } })
    expect(routeRunKind(route)).toBe('agent')
  })

  it('pilot + passthrough remains a single AgentLoop route', () => {
    const route = resolveAgentTurnRoute(baseInput({ mode: 'pilot' }))
    expect(route.kind).toBe('agent')
    expect(routeRunKind(route)).toBe('agent')
    if (route.kind === 'agent') {
      expect(route.dispatch.kind).toBe('passthrough')
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

  it.each([false, true])('领航用户 Slash 许可在正文注入或 fork 前按当前身份校验（fork=%s）', forkAgent => {
    const root = mkdtempSync(join(tmpdir(), 'nova-route-pilot-'))
    roots.push(root)
    const registry = createRegistry(root, [{ name: 'domain', forkAgent }])
    const skill = registry.get('domain')!
    const request = { content: '/domain task', mode: 'pilot' as const, skillRegistry: registry, workspacePath: root }
    expect(resolveAgentTurnRoute(request)).toMatchObject({
      kind: 'slash_rejected', rejection: { reason: 'not_user_invocable', skillName: 'domain' }
    })
    const id = createSkillId(skill, root)
    const accepted = resolveAgentTurnRoute({ ...request, pilotSkillIds: [id] })
    expect(accepted.kind).toBe(forkAgent ? 'skill_fork' : 'agent')
    if (accepted.kind === 'agent') expect(accepted.dispatch.kind).toBe('inject')
    // 全局 Skill 许可跨工作区保持有效
    expect(resolveAgentTurnRoute({ ...request, workspacePath: join(root, 'another-workspace'), pilotSkillIds: [id] }).kind)
      .toBe(forkAgent ? 'skill_fork' : 'agent')

    // 项目级 Skill 许可严格绑定原工作区，切换工作区后拒绝
    const projectDir = join(root, '.nova', 'skills')
    mkdirSync(join(projectDir, 'proj-only'), { recursive: true })
    writeFileSync(
      join(projectDir, 'proj-only', 'SKILL.md'),
      [
        '---',
        'name: proj-only',
        'description: project scoped skill',
        'user-invocable: true',
        ...(forkAgent ? ['fork_agent: true'] : []),
        '---',
        'PROJECT_BODY'
      ].join('\n')
    )
    const projectRegistry = SkillRegistry.load({ globalDir: join(root, 'skills'), projectDir })
    const projectSkill = projectRegistry.get('proj-only')!
    const projectId = createSkillId(projectSkill, root)
    expect(resolveAgentTurnRoute({
      content: '/proj-only task',
      mode: 'pilot',
      skillRegistry: projectRegistry,
      workspacePath: root,
      pilotSkillIds: [projectId]
    }).kind).toBe(forkAgent ? 'skill_fork' : 'agent')
    expect(resolveAgentTurnRoute({
      content: '/proj-only task',
      mode: 'pilot',
      skillRegistry: projectRegistry,
      workspacePath: join(root, 'another-workspace'),
      pilotSkillIds: [projectId]
    }).kind).toBe('slash_rejected')

    expect(resolveAgentTurnRoute({ ...request, mode: 'default' }).kind).toBe(forkAgent ? 'skill_fork' : 'agent')
    expect(resolveAgentTurnRoute({ ...request, mode: 'plan' }).kind).toBe(forkAgent ? 'skill_fork' : 'agent')
  })

  it('领航不会把已许可同名 Skill 的其他来源或附件路径当成原身份', () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-route-replaced-'))
    roots.push(root)
    const registry = createRegistry(root, [{ name: 'domain' }])
    const previous = registry.get('domain')!
    const id = createSkillId(previous, root)
    const projectDir = join(root, 'project-skills')
    mkdirSync(join(projectDir, 'domain'), { recursive: true })
    writeFileSync(join(projectDir, 'domain', 'SKILL.md'), '---\nname: domain\ndescription: replacement\n---\nREPLACEMENT_BODY')
    const replaced = SkillRegistry.load({ globalDir: join(root, 'skills'), projectDir })
    expect(resolveAgentTurnRoute({
      content: '/domain', mode: 'pilot', skillRegistry: replaced, workspacePath: root, pilotSkillIds: [id]
    }).kind).toBe('slash_rejected')
  })

  it('未找到的 slash → slash_rejected（不进 agent 执行）', () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-route-'))
    roots.push(root)
    const registry = createRegistry(root, [])
    const route = resolveAgentTurnRoute(baseInput({
      content: '/nonexistent-skill',
      skillRegistry: registry
    }))
    expect(route.kind).toBe('slash_rejected')
    if (route.kind === 'slash_rejected') {
      expect(route.rejection.reason).toBe('not_found')
      expect(route.rejection.skillName).toBe('nonexistent-skill')
    }
  })

  it('原生命令不依赖 skillRegistry，compact 与 plan 使用独立 route', () => {
    expect(resolveAgentTurnRoute(baseInput({ content: '/compact' }))).toEqual({ kind: 'compact' })
    expect(resolveAgentTurnRoute(baseInput({ content: '/plan' }))).toEqual({ kind: 'plan' })
  })

  it('init 展开真实工作区指令与用户参数，不伪装成 skill inject', () => {
    const route = resolveAgentTurnRoute(baseInput({ content: '/init 保留现有示例' }))
    expect(route.kind).toBe('agent')
    if (route.kind === 'agent') {
      expect(route.dispatch.kind).toBe('command')
      if (route.dispatch.kind === 'command') {
        expect(route.dispatch.userContent).toContain('真实检查当前工作区')
        expect(route.dispatch.userContent).toContain('只能创建或更新工作区根目录的 AGENTS.md')
        expect(route.dispatch.userContent).toContain('保留仍然准确有效的内容')
        expect(route.dispatch.userContent).toContain('保留现有示例')
      }
      expect(route.dispatch).not.toHaveProperty('assistantContent')
    }
  })

  it.each([
    [{ content: '/compact extra' }, 'invalid_arguments'],
    [{ content: '/compact', regenerate: true }, 'unsupported_action'],
    [{ content: '/compact', hasImages: true }, 'invalid_arguments'],
    [{ content: '/init', mode: 'plan' as const }, 'mode_not_allowed']
  ] as const)('原生命令共享校验进入 slash_rejected %#', (overrides, reason) => {
    const route = resolveAgentTurnRoute(baseInput(overrides))
    expect(route.kind).toBe('slash_rejected')
    if (route.kind === 'slash_rejected') {
      expect(route.rejection).toMatchObject({ type: 'command', reason })
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
  it('所有公开 route 都进入普通 Agent run', () => {
    expect(routeRunKind({ kind: 'skill_fork', skill: {} as never, args: '' })).toBe('agent')
    expect(routeRunKind({ kind: 'compact' })).toBe('agent')
    expect(routeRunKind({ kind: 'plan' })).toBe('agent')
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
    const route = agentRoute({ kind: 'inject', assistantContent: 'a', userContent: 'u' })
    expect(route.kind).toBe('agent')
    if (route.kind === 'agent') {
      expect(route.dispatch.kind).toBe('inject')
    }
  })
})
