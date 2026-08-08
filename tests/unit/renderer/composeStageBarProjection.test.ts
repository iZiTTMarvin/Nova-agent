import { describe, expect, it } from 'vitest'
import {
  projectStageBar,
  shouldShowComposeStageBar
} from '../../../src/renderer/features/compose/stageBarProjection'
import type { ComposeStageEntry } from '../../../src/shared/composeLifecycle'

function stages(partial: Array<Partial<ComposeStageEntry> & { id: ComposeStageEntry['id'] }>): ComposeStageEntry[] {
  return partial.map((entry) => ({ status: 'pending', ...entry }) as ComposeStageEntry)
}

describe('projectStageBar', () => {
  it('stages 为 null 时按初始表投影：构思为当前阶段，其余待办', () => {
    const projection = projectStageBar(null)
    expect(projection.nodes.map((node) => node.label)).toEqual([
      '构思', '计划', '开发', '验证', '审查', '收尾'
    ])
    expect(projection.nodes[0]).toMatchObject({ id: 'brainstorm', status: 'in_progress', isCurrent: true })
    expect(projection.nodes.slice(1).every((node) => node.status === 'pending' && !node.isCurrent)).toBe(true)
    expect(projection.currentStageId).toBe('brainstorm')
    expect(projection.isTerminal).toBe(false)
    expect(projection.returnTargets).toEqual([])
  })

  it('stages 为 undefined 时同样按初始表投影', () => {
    const projection = projectStageBar(undefined)
    expect(projection.currentStageId).toBe('brainstorm')
    expect(projection.nodes).toHaveLength(6)
  })

  it('六种状态映射：completed 带完成时间、in_progress 为当前、skipped 带原因', () => {
    const projection = projectStageBar(stages([
      { id: 'brainstorm', status: 'completed', completedAt: 1000 },
      { id: 'plan', status: 'skipped', note: '需求简单直接开发', completedAt: 2000 },
      { id: 'implement', status: 'in_progress' },
      { id: 'verify' },
      { id: 'review' },
      { id: 'report' }
    ]))

    expect(projection.nodes[0]).toMatchObject({ status: 'completed', completedAt: 1000, isCurrent: false })
    expect(projection.nodes[1]).toMatchObject({ status: 'skipped', note: '需求简单直接开发' })
    expect(projection.nodes[2]).toMatchObject({ status: 'in_progress', isCurrent: true })
    expect(projection.currentStageId).toBe('implement')
    expect(projection.isTerminal).toBe(false)
    // 回退目标为当前阶段之前的阶段，与转换校验口径一致
    expect(projection.returnTargets.map((target) => target.id)).toEqual(['brainstorm', 'plan'])
  })

  it('回退后再度进行中的阶段保留回退原因 note', () => {
    const projection = projectStageBar(stages([
      { id: 'brainstorm', status: 'completed', completedAt: 1000 },
      { id: 'plan', status: 'in_progress', note: '验证失败，返工补充方案' },
      { id: 'implement' },
      { id: 'verify' },
      { id: 'review' },
      { id: 'report' }
    ]))

    expect(projection.nodes[1]).toMatchObject({ status: 'in_progress', note: '验证失败，返工补充方案', isCurrent: true })
    expect(projection.returnTargets.map((target) => target.id)).toEqual(['brainstorm'])
  })

  it('终态（全部 completed/skipped、无 in_progress）：无当前阶段，所有阶段均可回退', () => {
    const projection = projectStageBar(stages([
      { id: 'brainstorm', status: 'completed', completedAt: 1 },
      { id: 'plan', status: 'completed', completedAt: 2 },
      { id: 'implement', status: 'completed', completedAt: 3 },
      { id: 'verify', status: 'skipped', note: '无代码改动', completedAt: 4 },
      { id: 'review', status: 'completed', completedAt: 5 },
      { id: 'report', status: 'completed', completedAt: 6 }
    ]))

    expect(projection.currentStageId).toBeNull()
    expect(projection.isTerminal).toBe(true)
    expect(projection.nodes.every((node) => !node.isCurrent)).toBe(true)
    expect(projection.returnTargets.map((target) => target.id)).toEqual([
      'brainstorm', 'plan', 'implement', 'verify', 'review', 'report'
    ])
  })

  it('缺失阶段的异常表补 pending，恒为六节点', () => {
    const projection = projectStageBar(stages([
      { id: 'implement', status: 'in_progress' }
    ]))

    expect(projection.nodes).toHaveLength(6)
    expect(projection.nodes[0]).toMatchObject({ id: 'brainstorm', status: 'pending' })
    expect(projection.currentStageId).toBe('implement')
    expect(projection.returnTargets.map((target) => target.id)).toEqual(['brainstorm', 'plan'])
  })

  it('传入 implementProgress 时只挂在开发节点上', () => {
    const projection = projectStageBar(
      stages([{ id: 'implement', status: 'in_progress' }]),
      { completed: 3, total: 5 }
    )

    const implementNode = projection.nodes.find((node) => node.id === 'implement')
    expect(implementNode?.progress).toEqual({ completed: 3, total: 5 })
    for (const node of projection.nodes) {
      if (node.id !== 'implement') expect(node.progress).toBeUndefined()
    }
  })

  it('未传 implementProgress 时开发节点没有 progress 字段', () => {
    const projection = projectStageBar(stages([{ id: 'implement', status: 'in_progress' }]))
    const implementNode = projection.nodes.find((node) => node.id === 'implement')
    expect(implementNode?.progress).toBeUndefined()
  })
})

describe('shouldShowComposeStageBar', () => {
  it('仅 compose 模式主会话显示', () => {
    expect(shouldShowComposeStageBar({ mode: 'compose', kind: 'primary' })).toBe(true)
  })

  it('default/plan 会话不显示', () => {
    expect(shouldShowComposeStageBar({ mode: 'default', kind: 'primary' })).toBe(false)
    expect(shouldShowComposeStageBar({ mode: 'plan', kind: 'primary' })).toBe(false)
  })

  it('compose 子代理会话不显示', () => {
    expect(shouldShowComposeStageBar({ mode: 'compose', kind: 'subagent' })).toBe(false)
  })

  it('无会话时不显示', () => {
    expect(shouldShowComposeStageBar(null)).toBe(false)
    expect(shouldShowComposeStageBar(undefined)).toBe(false)
  })
})
