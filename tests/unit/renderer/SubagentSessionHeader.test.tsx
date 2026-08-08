// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SubagentSessionHeader } from '../../../src/renderer/features/subagents/SubagentSessionHeader'
import { useSubagentProjectionStore } from '../../../src/renderer/features/subagents/projection'
import { resetAgentStoreForTests, useAgentStore } from '../../../src/renderer/stores/useAgentStore'
import { resetChatStoreForTests, useChatStore } from '../../../src/renderer/stores/useChatStore'
import type { Session } from '../../../src/shared/session/types'
import type { SubagentActivityProjection } from '../../../src/shared/subagents'
import { act, renderDom } from './renderDom'

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

    const renderer = renderDom(
      <SubagentSessionHeader originalTask="inspect the durable session history" />
    )

    const output = renderer.container.textContent ?? ''
    expect(output).toContain('inspect the durable session history')
    expect(output).toContain('只读')

    const backButton = Array.from(renderer.container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('返回父任务'))
    const stopButton = renderer.container.querySelector<HTMLButtonElement>('button[aria-label="停止子代理 Explore"]')
    expect(backButton).toBeDefined()
    expect(stopButton).not.toBeNull()
    act(() => {
      backButton!.click()
      stopButton!.click()
    })
    expect(selectSession).toHaveBeenCalledWith('parent-session')
    expect(cancelExecution).toHaveBeenCalledWith('child-run')
    renderer.unmount()
  })
})
