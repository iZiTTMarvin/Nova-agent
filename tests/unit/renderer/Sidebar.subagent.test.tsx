// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../../../src/renderer/components/Sidebar'
import { useSubagentProjectionStore } from '../../../src/renderer/features/subagents/projection'
import { resetAgentStoreForTests } from '../../../src/renderer/stores/useAgentStore'
import { resetChatStoreForTests, useChatStore } from '../../../src/renderer/stores/useChatStore'
import { resetSettingsStoreForTests, useSettingsStore } from '../../../src/renderer/stores/useSettingsStore'
import type { Session } from '../../../src/shared/session/types'
import { act, renderDom } from './renderDom'

vi.mock('../../../src/renderer/components/Icons', () => ({
  NovaLogo: () => null,
  FolderIcon: () => null,
  SettingsIcon: () => null,
  PlusIcon: () => null,
  ChevronIcon: () => null,
  TrashIcon: () => null,
  EditIcon: () => null
}))
vi.mock('framer-motion', () => import('./_framerMotionMock'))

const parent: Session = {
  id: 'parent-session',
  kind: 'primary',
  workspaceRoot: 'D:/workspace',
  mode: 'default',
  createdAt: 1,
  updatedAt: 2,
  messageCount: 1,
  title: 'Parent task'
}

const child: Session = {
  id: 'child-session',
  kind: 'subagent',
  workspaceRoot: 'D:/workspace',
  mode: 'plan',
  createdAt: 2,
  updatedAt: 2,
  messageCount: 1,
  title: 'Inspect runtime boundaries',
  subagent: {
    lineage: { parentSessionId: parent.id, depth: 1 },
    profile: {
      profileId: 'explore',
      name: 'Explore',
      permissionCeiling: 'read_only'
    }
  }
}

describe('Sidebar child session accessibility', () => {
  beforeEach(() => {
    resetChatStoreForTests()
    resetSettingsStoreForTests()
    resetAgentStoreForTests()
    useSubagentProjectionStore.getState().resetForTests()
  })

  it('为 Child Session 提供可聚焦按钮、可见状态文字与选择路由', () => {
    const selectSession = vi.fn().mockResolvedValue(undefined)
    useChatStore.setState({ sessions: [parent, child], currentSessionId: parent.id, selectSession })
    useSettingsStore.setState({ currentProject: 'D:/workspace' })
    useSubagentProjectionStore.getState().hydrateParent(parent.id, [{
      childSessionId: child.id,
      childRunId: 'child-run',
      parentSessionId: parent.id,
      parentToolCallId: 'parent-call',
      taskLabel: child.title!,
      profile: child.subagent.profile,
      status: 'running',
      sequence: 2,
      startedAt: 1,
      artifactCount: 0
    }])

    const renderer = renderDom(<Sidebar />)
    const openChild = renderer.container.querySelector<HTMLButtonElement>(
      'button[aria-label="打开会话 Inspect runtime boundaries，运行中"]'
    )

    expect(openChild).toBeDefined()
    expect(renderer.container.textContent ?? '').toContain('运行中')
    act(() => openChild?.click())
    expect(selectSession).toHaveBeenCalledWith(child.id)
    renderer.unmount()
  })
})
