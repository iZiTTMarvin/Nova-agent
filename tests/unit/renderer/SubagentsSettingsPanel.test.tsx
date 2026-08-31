// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SubagentsSettingsPanel } from '../../../src/renderer/features/settings/SubagentsSettingsPanel'
import { resetSettingsStoreForTests, useSettingsStore } from '../../../src/renderer/stores/useSettingsStore'
import type { SubagentListItem, SubagentsListResult } from '../../../src/shared/settings/types'
import { act, renderDom } from './renderDom'

const builtin: SubagentListItem = {
  id: 'explore',
  name: 'explore',
  description: '只读探索',
  enabled: true,
  allowedTools: ['ls', 'read', 'grep'],
  prompt: '只读探索代码。',
  maxToolRounds: 20,
  builtin: true,
  origin: 'builtin'
}

const listResult: SubagentsListResult = {
  items: [builtin],
  diagnostics: [],
  tools: [
    { name: 'ls', effects: ['filesystem.read'], selectable: true },
    { name: 'read', effects: ['filesystem.read'], selectable: true },
    { name: 'grep', effects: ['filesystem.read'], selectable: true },
    { name: 'find', effects: ['filesystem.read'], selectable: true },
    { name: 'code_context', effects: ['filesystem.read'], selectable: true },
    { name: 'edit', effects: ['filesystem.read', 'filesystem.write'], selectable: true },
    { name: 'write', effects: ['filesystem.write'], selectable: true },
    { name: 'bash', effects: ['shell.execute'], selectable: true },
    { name: 'shell_session', effects: ['shell.execute', 'process.control'], selectable: true }
  ]
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find(candidate => candidate.getAttribute('aria-label') === name || candidate.textContent?.trim() === name)
  if (!found) throw new Error(`button not found: ${name}`)
  return found
}

function input(container: HTMLElement, label: string): HTMLInputElement | HTMLTextAreaElement {
  const labelElement = [...container.querySelectorAll('label')]
    .find(candidate => candidate.textContent?.includes(label))
  const id = labelElement?.getAttribute('for')
  const found = id
    ? document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null
    : null
  if (!found) throw new Error(`input not found: ${label}`)
  return found
}

async function changeInput(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  await act(async () => {
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('SubagentsSettingsPanel 结构化设置交互', () => {
  beforeEach(() => {
    resetSettingsStoreForTests()
    useSettingsStore.setState({ currentProject: 'D:\\workspace', llmRegistry: null })
  })

  it('通过两步向导创建，提交期间禁止重复请求，成功后进入权威详情', async () => {
    let resolveCreate: ((value: SubagentListItem) => void) | undefined
    const saved: SubagentListItem = {
      ...builtin,
      id: 'risk-review',
      name: '风险审查',
      builtin: false,
      origin: 'global'
    }
    let created = false
    const invoke = vi.fn((channel: string) => {
      if (channel === 'subagents:list') {
        return Promise.resolve(created ? { ...listResult, items: [builtin, saved] } : listResult)
      }
      if (channel === 'subagents:create') {
        return new Promise<SubagentListItem>(resolve => {
          resolveCreate = resolve
        })
      }
      return Promise.resolve(undefined)
    })
    global.window.api = { invoke, on: vi.fn(() => () => {}), removeAllListeners: vi.fn() } as never

    const { container, unmount } = renderDom(<SubagentsSettingsPanel />)
    await flush()
    await act(async () => button(container, '创建子代理').click())

    const nameInput = input(container, '显示名称')
    await changeInput(nameInput, '风险审查')
    expect((input(container, '稳定 ID') as HTMLInputElement).value).toBe('subagent')

    await act(async () => button(container, '下一步').click())
    expect(container.textContent).toContain('步骤 2 / 2')

    await act(async () => button(container, '确认创建').click())
    expect(button(container, '创建中…').disabled).toBe(true)
    expect(invoke.mock.calls.filter(call => call[0] === 'subagents:create')).toHaveLength(1)

    await act(async () => {
      created = true
      resolveCreate?.(saved)
    })
    await flush()
    expect(container.textContent).toContain('全局配置')
    expect(container.textContent).toContain('risk-review')
    unmount()
  })

  it('保存失败时保留向导草稿并显示页面错误', async () => {
    const invoke = vi.fn((channel: string) => {
      if (channel === 'subagents:list') return Promise.resolve(listResult)
      if (channel === 'load-llm-registry') return Promise.resolve(null)
      if (channel === 'subagents:create') return Promise.reject(new Error('该层级已存在同 ID 子代理'))
      return Promise.resolve(undefined)
    })
    global.window.api = { invoke, on: vi.fn(() => () => {}), removeAllListeners: vi.fn() } as never

    const { container, unmount } = renderDom(<SubagentsSettingsPanel />)
    await flush()
    await act(async () => button(container, '创建子代理').click())
    const nameInput = input(container, '显示名称')
    await changeInput(nameInput, '重复助手')
    await act(async () => button(container, '下一步').click())
    await act(async () => button(container, '确认创建').click())
    await flush()

    expect(container.textContent).toContain('该层级已存在同 ID 子代理')
    expect((input(container, '显示名称') as HTMLInputElement).value).toBe('重复助手')
    expect(container.textContent).toContain('步骤 2 / 2')
    unmount()
  })

  it('内置项只能查看，复制后得到独立可编辑草稿', async () => {
    const invoke = vi.fn((channel: string) => {
      if (channel === 'subagents:list') return Promise.resolve(listResult)
      if (channel === 'load-llm-registry') return Promise.resolve(null)
      return Promise.resolve(undefined)
    })
    global.window.api = { invoke, on: vi.fn(() => () => {}), removeAllListeners: vi.fn() } as never

    const { container, unmount } = renderDom(<SubagentsSettingsPanel />)
    await flush()
    expect(container.textContent).toContain('内置能力 · 只读')
    expect(container.textContent).not.toContain('删除配置')

    await act(async () => button(container, '复制为自定义').click())
    expect(container.textContent).toContain('步骤 2 / 2')
    expect((input(container, '显示名称') as HTMLInputElement).value).toBe('explore 副本')
    expect((input(container, '稳定 ID') as HTMLInputElement).value).not.toBe('explore')
    unmount()
  })
})
