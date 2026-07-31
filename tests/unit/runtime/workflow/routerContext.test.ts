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

