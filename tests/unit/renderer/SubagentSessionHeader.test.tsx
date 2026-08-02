import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SubagentSessionHeader } from '../../../src/renderer/features/subagents/SubagentSessionHeader'
import { useSubagentProjectionStore } from '../../../src/renderer/features/subagents/projection'
import { resetAgentStoreForTests, useAgentStore } from '../../../src/renderer/stores/useAgentStore'
import { resetChatStoreForTests, useChatStore } from '../../../src/renderer/stores/useChatStore'
import type { Session } from '../../../src/shared/session/types'
import type { SubagentActivityProjection } from '../../../src/shared/subagents'

const session: Session = {
  id: 'child-session',
  kind: 'subagent',
  workspaceRoot: 'D:/workspace',
  mode: 'default',
  createdAt: 1,
  updatedAt: 1,
  messageCount: 1,
  subagent: {
    lineage: {
      parentSessionId: 'parent-session',
      depth: 1
    },
    profile: {
      profileId: 'explore',
      name: 'Explore',
      permissionCeiling: 'read_only'
    }
  }
}

const projection: SubagentActivityProjection = {
  childSessionId: session.id,
  childRunId: 'child-run',
  parentSessionId: 'parent-session',
  parentToolCallId: 'parent-tool-call',
  taskLabel: 'inspect the durable session history',
  profile: session.subagent.profile,
  status: 'running',
  sequence: 2,
  startedAt: 1,
  artifactCount: 0
}

describe('SubagentSessionHeader', () => {
  beforeEach(() => {
    resetChatStoreForTests()
    resetAgentStoreForTests()
    useSubagentProjectionStore.getState().resetForTests()
  })

  it('展示持久化原始任务，并将返回与停止路由到正确 owner', () => {
    const selectSession = vi.fn().mockResolvedValue(undefined)
    const cancelExecution = vi.fn().mockResolvedValue(undefined)
    useChatStore.setState({
      sessions: [session],
      currentSessionId: session.id,
      selectSession
    })
    useAgentStore.setState({ cancelExecution })
    useSubagentProjectionStore.getState().hydrateParent('parent-session', [projection])

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <SubagentSessionHeader originalTask="inspect the durable session history" />
      )
    })

    const output = JSON.stringify(renderer!.toJSON())
    expect(output).toContain('inspect the durable session history')
    expect(output).toContain('只读')

    act(() => {
      renderer!.root.findByProps({ 'aria-label': '返回父任务' }).props.onClick()
      renderer!.root.findByProps({ 'aria-label': '停止子代理 Explore' }).props.onClick()
    })
    expect(selectSession).toHaveBeenCalledWith('parent-session')
    expect(cancelExecution).toHaveBeenCalledWith('child-run')
  })
})
