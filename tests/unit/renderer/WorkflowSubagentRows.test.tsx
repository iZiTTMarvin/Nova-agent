import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubagentActivityProjection } from '../../../src/shared/subagents'
import { WorkflowSubagentRows } from '../../../src/renderer/features/subagents/WorkflowSubagentRows'
import { useSubagentProjectionStore } from '../../../src/renderer/features/subagents/projection'
import { useChatStore, resetChatStoreForTests } from '../../../src/renderer/stores/useChatStore'

function projection(
  childSessionId: string,
  status: SubagentActivityProjection['status'],
  overrides: Partial<NonNullable<SubagentActivityProjection['workflow']>> = {}
): SubagentActivityProjection {
  return {
    childSessionId,
    childRunId: `run-${childSessionId}`,
    parentSessionId: 'parent-session',
    parentToolCallId: 'workflow-tool',
    workflow: {
      workflowRunId: 'workflow-run',
      phase: 'research',
      taskId: childSessionId,
      batchId: 'research-0',
      occurrence: 0,
      ...overrides
    },
    profile: {
      profileId: 'workflow-readonly',
      name: 'researcher',
      permissionCeiling: 'read_only'
    },
    taskLabel: childSessionId,
    status,
    artifactCount: 0
  }
}

describe('WorkflowSubagentRows', () => {
  beforeEach(() => {
    resetChatStoreForTests()
    useSubagentProjectionStore.getState().resetForTests()
    useChatStore.setState({
      currentSessionId: 'parent-session',
      selectSession: vi.fn()
    } as never)
  })

  it('同一 batchId 的 Workflow child runs 聚合为 batch row，状态由成员推导', () => {
    const first = projection('child-a', 'completed')
    const second = projection('child-b', 'failed')
    useSubagentProjectionStore.setState({
      byChildSessionId: { 'child-a': first, 'child-b': second },
      childIdsByParentSessionId: { 'parent-session': ['child-a', 'child-b'] },
      childSessionIdByParentToolCallId: {}
    })
    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <WorkflowSubagentRows
          toolCallId="workflow-tool"
          name="start_workflow"
          args={{}}
          status="completed"
        />
      )
    })

    const section = renderer.root.findByProps({ className: 'subagent-batch-row' })
    expect(section.props['aria-label']).toBe('并行执行，2 个子代理')
    expect(section.findAllByType('button')).toHaveLength(2)
    expect(section.findAllByType('span').map((node) => node.children.join('')))
      .toContain('partial')
  })

  it('相同 toolCallId 但不同 parent session 的 child 不会串到当前行', () => {
    const current = projection('child-current', 'completed', { batchId: undefined })
    const other = {
      ...projection('child-other', 'completed', { batchId: undefined }),
      parentSessionId: 'other-parent-session'
    }
    useSubagentProjectionStore.setState({
      byChildSessionId: { current, other },
      childIdsByParentSessionId: {
        'parent-session': ['child-current', 'child-other']
      },
      childSessionIdByParentToolCallId: {}
    })
    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <WorkflowSubagentRows
          toolCallId="workflow-tool"
          name="start_workflow"
          args={{}}
          status="completed"
        />
      )
    })

    expect(renderer.root.findAll(
      (node) =>
        typeof node.props.className === 'string' &&
        node.props.className.split(' ').includes('subagent-activity-row')
    )).toHaveLength(1)
  })

  it('同一 parent/tool 出现多个 workflowRunId 时 fail closed 为普通工具行', () => {
    const first = projection('child-first', 'completed', { batchId: undefined })
    const second = projection('child-second', 'completed', {
      workflowRunId: 'other-workflow-run',
      batchId: undefined
    })
    useSubagentProjectionStore.setState({
      byChildSessionId: { first, second },
      childIdsByParentSessionId: {
        'parent-session': ['child-first', 'child-second']
      },
      childSessionIdByParentToolCallId: {}
    })
    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <WorkflowSubagentRows
          toolCallId="workflow-tool"
          name="start_workflow"
          args={{}}
          status="completed"
        />
      )
    })

    expect(renderer.root.findAll(
      (node) =>
        typeof node.props.className === 'string' &&
        node.props.className.split(' ').includes('subagent-activity-row')
    )).toHaveLength(0)
    expect(renderer.root.findAllByProps({ className: 'tool-trace-row' })).toHaveLength(1)
  })
})
