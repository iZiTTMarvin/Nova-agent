import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildRouterContext,
  renderRouterContext
} from '../../../../src/runtime/workflow/router'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('workflow router context', () => {
  it('收集可读取 active plan 和注册表元数据，并渲染 compose 路由提示', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'nova-router-context-'))
    roots.push(workspaceRoot)
    mkdirSync(join(workspaceRoot, '.nova', 'plans'), { recursive: true })
    writeFileSync(
      join(workspaceRoot, '.nova', 'plans', 'login.md'),
      '# 登录计划\n\n先确认认证边界。\n\n再实现接口。'
    )

    const context = buildRouterContext({
      workspaceRoot,
      activePlan: { path: '.nova/plans/login.md' }
    })

    expect(context.hasActivePlan).toBe(true)
    expect(context.planPath).toBe('.nova/plans/login.md')
    expect(context.planSummary).toContain('# 登录计划')
    expect(context.availableWorkflows.map(workflow => workflow.name)).toContain('compose')
    expect(renderRouterContext(context)).toContain('start_workflow')
  })

  it('注册表里的三条 workflow 及其匹配信号都进入路由提示', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'nova-router-context-'))
    roots.push(workspaceRoot)

    const context = buildRouterContext({ workspaceRoot })
    expect(context.availableWorkflows.map(workflow => workflow.name)).toEqual([
      'compose',
      'deep-research',
      'code-review'
    ])

    // 起始阶段必须如实反映各 workflow 声明的入口，否则模型会传入 orchestrator 会拒绝的 startStage
    const byName = new Map(context.availableWorkflows.map(workflow => [workflow.name, workflow]))
    expect(byName.get('deep-research')?.stages).toEqual(['brief'])
    expect(byName.get('code-review')?.stages).toEqual(['review'])

    // matchHints 是模型区分三类请求的唯一细粒度信号，必须被渲染而不是停在类型里
    const rendered = renderRouterContext(context)
    for (const workflow of context.availableWorkflows) {
      expect(workflow.matchHints.length).toBeGreaterThan(0)
      for (const hint of workflow.matchHints) expect(rendered).toContain(hint)
    }
    expect(rendered).toContain('deep-research')
    expect(rendered).toContain('code-review')
  })

  it('active plan 不可读取时不伪造计划上下文', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'nova-router-context-'))
    roots.push(workspaceRoot)

    const context = buildRouterContext({
      workspaceRoot,
      activePlan: { path: '.nova/plans/missing.md' }
    })

    expect(context.hasActivePlan).toBe(false)
    expect(context.planPath).toBeNull()
    expect(context.planSummary).toBeNull()
  })
})

