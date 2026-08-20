// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../../../src/renderer/components/Sidebar'
import { SubagentActivityRow } from '../../../src/renderer/features/subagents/SubagentActivityRow'
import { useSubagentProjectionStore } from '../../../src/renderer/features/subagents/projection'
import { resetAgentStoreForTests } from '../../../src/renderer/stores/useAgentStore'
import { resetChatStoreForTests, useChatStore } from '../../../src/renderer/stores/useChatStore'
import { resetSettingsStoreForTests, useSettingsStore } from '../../../src/renderer/stores/useSettingsStore'
import { resetCodeIndexStoreForTests, useCodeIndexStore } from '../../../src/renderer/stores/useCodeIndexStore'
import type { Session } from '../../../src/shared/session/types'
import type { SubagentActivityProjection } from '../../../src/shared/subagents'
import { act, renderDom } from './renderDom'

vi.mock('../../../src/renderer/components/Icons', () => ({
  NovaLogo: () => null,
  FolderIcon: () => null,
  SettingsIcon: () => null,
  PlusIcon: () => null,
  PinIcon: () => null,
  PanelLeftIcon: () => null
}))

function findSessionButton(container: HTMLElement, title: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((button) => {
    const text = button.textContent ?? ''
    return text.includes(title) && !text.includes('个任务')
  })
}

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

const projection: SubagentActivityProjection = {
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
}

describe('Sidebar 子代理会话退出列表', () => {
  beforeEach(() => {
    resetChatStoreForTests()
    resetSettingsStoreForTests()
    resetAgentStoreForTests()
    resetCodeIndexStoreForTests()
    useSubagentProjectionStore.getState().resetForTests()
  })

  it('侧栏只展示 primary 会话，store 仍保留子代理数据', () => {
    const selectSession = vi.fn().mockResolvedValue(undefined)
    useChatStore.setState({ sessions: [parent, child], currentSessionId: parent.id, selectSession })
    useSettingsStore.setState({ currentProject: 'D:/workspace' })

    const renderer = renderDom(<Sidebar />)
    const text = renderer.container.textContent ?? ''

    expect(useChatStore.getState().sessions.map((session) => session.id)).toEqual([
      parent.id,
      child.id
    ])
    expect(text).toContain('Parent task')
    expect(text).not.toContain('Inspect runtime boundaries')
    expect(text).toContain('1 个任务')
    expect(findSessionButton(renderer.container, 'Inspect runtime boundaries')).toBeUndefined()
    expect(findSessionButton(renderer.container, 'Parent task')).toBeTruthy()

    act(() => {
      findSessionButton(renderer.container, 'Parent task')?.click()
    })
    expect(selectSession).toHaveBeenCalledWith(parent.id)
    expect(selectSession).not.toHaveBeenCalledWith(child.id)
    renderer.unmount()
  })

  it('焦点落在子代理会话时，侧栏高亮父会话', () => {
    useChatStore.setState({
      sessions: [parent, child],
      currentSessionId: child.id,
      selectSession: vi.fn().mockResolvedValue(undefined)
    })
    useSettingsStore.setState({ currentProject: 'D:/workspace' })

    const renderer = renderDom(<Sidebar />)
    const parentButton = findSessionButton(renderer.container, 'Parent task')
    expect(parentButton?.getAttribute('aria-current')).toBe('page')
    expect(renderer.container.textContent ?? '').not.toContain('Inspect runtime boundaries')
    renderer.unmount()
  })

  it('父子数据仍在时，消息流活动行可正常渲染', () => {
    useChatStore.setState({
      sessions: [parent, child],
      currentSessionId: parent.id
    })
    useSubagentProjectionStore.getState().hydrateParent(parent.id, [projection])

    const renderer = renderDom(<SubagentActivityRow projection={projection} />)
    const output = renderer.container.textContent ?? ''
    expect(useChatStore.getState().sessions.some((session) => session.kind === 'subagent')).toBe(true)
    // 紧凑行展示 profile 名与运行态，不再把 taskLabel 放在主行
    expect(output).toContain('Explore')
    expect(output).toContain('正在工作')
    expect(renderer.container.querySelector('.subagent-activity-row--running')).not.toBeNull()
    renderer.unmount()
  })

  it('代码索引状态只挂在项目分组行，点击异常点进入设置', () => {
    useChatStore.setState({ sessions: [parent], currentSessionId: parent.id })
    useSettingsStore.setState({ currentProject: 'D:/workspace' })
    useCodeIndexStore.setState({
      currentWorkspaceRoot: 'D:/workspace',
      snapshotsByWorkspaceRoot: {
        'D:/workspace': {
          workspaceRoot: 'D:/workspace',
          sequence: 1,
          enabled: true,
          status: 'degraded',
          activeGeneration: 1,
          revision: 2,
          coverage: {
            eligibleFiles: 1,
            indexedFiles: 1,
            parseFailures: 0,
            unsupportedFiles: 0,
            oversizedFiles: 0,
            unresolvedRelations: 0
          },
          progress: null,
          lastCompletedAt: 1,
          failure: { code: 'watcher_failed', message: 'watch failed' },
          workerState: 'failed',
          databaseBytes: 1
        }
      }
    })

    const renderer = renderDom(<Sidebar />)
    const dots = renderer.container.querySelectorAll('[aria-label="代码索引不可用"]')
    expect(dots).toHaveLength(1)
    expect(dots[0].getAttribute('role')).toBe('button')
    expect(dots[0].getAttribute('tabindex')).toBe('0')
    expect(findSessionButton(renderer.container, 'Parent task')?.querySelector('[aria-label="代码索引不可用"]')).toBeNull()

    act(() => {
      dots[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useSettingsStore.getState().isConfigModalOpen).toBe(true)
    expect(sessionStorage.getItem('nova-settings-nav')).toBe('codeindex')
    renderer.unmount()
  })
})
