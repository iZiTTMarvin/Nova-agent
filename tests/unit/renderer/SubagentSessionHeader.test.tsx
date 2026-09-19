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

const mockInvoke = vi.fn()

// @ts-expect-error test environment
global.window.api = { invoke: mockInvoke }

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

function makeInterruptedProjection(overrides: Partial<SubagentActivityProjection> = {}): SubagentActivityProjection {
  return {
    childSessionId: session.id,
    childRunId: 'interrupted-run',
    parentSessionId: 'parent-session',
    parentToolCallId: 'parent-tool-call',
    taskLabel: 'was interrupted',
    profile: session.subagent.profile,
    status: 'interrupted',
    sequence: 3,
    startedAt: 1,
    artifactCount: 0,
    ...overrides
  }
}

describe('SubagentSessionHeader', () => {
  beforeEach(() => {
    resetChatStoreForTests()
    resetAgentStoreForTests()
    useSubagentProjectionStore.getState().resetForTests()
    mockInvoke.mockReset()
    mockInvoke.mockResolvedValue({ accepted: true })
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

  it('interrupted 状态显示继续按钮，与停止互斥', () => {
    const selectSession = vi.fn().mockResolvedValue(undefined)
    useChatStore.setState({
      sessions: [session],
      currentSessionId: session.id,
      selectSession
    })
    const interrupted = makeInterruptedProjection()
    useSubagentProjectionStore.getState().hydrateParent('parent-session', [interrupted])

    const renderer = renderDom(<SubagentSessionHeader />)
    const output = renderer.container.textContent ?? ''
    expect(output).toContain('继续此子任务')
    expect(output).not.toContain('停止')
    renderer.unmount()
  })

  it('点击继续按钮调用 send-message 且参数含稳定 userMessageId 与两个 id', async () => {
    vi.useFakeTimers()
    try {
      const selectSession = vi.fn().mockResolvedValue(undefined)
      useChatStore.setState({
        sessions: [session],
        currentSessionId: session.id,
        selectSession
      })
      const interrupted = makeInterruptedProjection()
      useSubagentProjectionStore.getState().hydrateParent('parent-session', [interrupted])

      const renderer = renderDom(<SubagentSessionHeader />)
      const resumeBtn = Array.from(renderer.container.querySelectorAll('button'))
        .find(b => b.textContent?.includes('继续此子任务'))
      expect(resumeBtn).toBeDefined()

      await act(async () => {
        resumeBtn!.click()
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(mockInvoke).toHaveBeenCalledWith('send-message', expect.objectContaining({
        sessionId: 'parent-session',
        userMessageId: expect.stringContaining('msg_resume_interrupted-run')
      }))
      renderer.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('submitting → waiting 状态流转；投影出现 resumedFromRunId 后显示 started', async () => {
    vi.useFakeTimers()
    try {
      let resolveDeferred!: (value: { accepted: boolean }) => void
      const deferred = new Promise<{ accepted: boolean }>(resolve => { resolveDeferred = resolve })
      mockInvoke.mockReturnValueOnce(deferred)
      const selectSession = vi.fn().mockResolvedValue(undefined)
      useChatStore.setState({
        sessions: [session],
        currentSessionId: session.id,
        selectSession
      })
      const interrupted = makeInterruptedProjection()
      useSubagentProjectionStore.getState().hydrateParent('parent-session', [interrupted])

      const renderer = renderDom(<SubagentSessionHeader />)
      const resumeBtn = Array.from(renderer.container.querySelectorAll('button'))
        .find(b => b.textContent?.includes('继续此子任务'))
      expect(resumeBtn).toBeDefined()

      await act(async () => {
        resumeBtn!.click()
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(renderer.container.textContent).toContain('提交中…')

      await act(async () => {
        resolveDeferred({ accepted: true })
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(renderer.container.textContent).toContain('已提交，等待父会话处理')

      act(() => {
        useSubagentProjectionStore.getState().hydrateParent('parent-session', [{
          ...interrupted,
          childRunId: 'resumed-run-id',
          status: 'running',
          resumedFromRunId: 'interrupted-run'
        }])
      })

      expect(renderer.container.textContent).toContain('已开始')
      renderer.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('拒绝时显示 failed 并可重试', async () => {
    vi.useFakeTimers()
    try {
      mockInvoke.mockResolvedValue({ accepted: false, rejection: { reason: 'agent_not_allowed', skillName: 'resume', suggestions: [] } })
      const selectSession = vi.fn().mockResolvedValue(undefined)
      useChatStore.setState({
        sessions: [session],
        currentSessionId: session.id,
        selectSession
      })
      const interrupted = makeInterruptedProjection()
      useSubagentProjectionStore.getState().hydrateParent('parent-session', [interrupted])

      const renderer = renderDom(<SubagentSessionHeader />)
      const resumeBtn = Array.from(renderer.container.querySelectorAll('button'))
        .find(b => b.textContent?.includes('继续此子任务'))

      await act(async () => {
        resumeBtn!.click()
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(renderer.container.textContent).toContain('父会话拒绝接收')
      renderer.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('active 状态不显示继续按钮', () => {
    const selectSession = vi.fn().mockResolvedValue(undefined)
    useChatStore.setState({
      sessions: [session],
      currentSessionId: session.id,
      selectSession
    })
    useSubagentProjectionStore.getState().hydrateParent('parent-session', [projection])

    const renderer = renderDom(<SubagentSessionHeader />)
    expect(renderer.container.textContent).not.toContain('继续此子任务')
    renderer.unmount()
  })
})
