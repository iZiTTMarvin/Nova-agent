// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InlinePermissionBar } from '../../../src/renderer/features/permissions/InlinePermissionBar'
import {
  resetAgentStoreForTests,
  useAgentStore
} from '../../../src/renderer/stores/useAgentStore'
import {
  resetChatStoreForTests,
  useChatStore
} from '../../../src/renderer/stores/useChatStore'
import { useWorkspaceStore } from '../../../src/renderer/stores/useWorkspaceStore'
import { PERMISSION_GRANT_SESSION_PATH, PERMISSION_UPSERT } from '../../../src/shared/ipc/channels'
import { act, renderDom } from './renderDom'
import type { PendingPermissionRequest } from '../../../src/renderer/stores/types'

const mockInvoke = vi.fn()

const request: PendingPermissionRequest = {
  messageId: 'msg_1',
  requestId: 'req_1',
  toolName: 'bash',
  args: { command: 'npm install' },
  riskLevel: 'low',
  reason: '安装依赖需要确认',
  toolCallIds: ['tc_1'],
  sessionId: 'sess_1',
  version: 1
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

describe('InlinePermissionBar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAgentStoreForTests()
    resetChatStoreForTests()
    useChatStore.setState({ currentSessionId: 'sess_1' })
    useWorkspaceStore.setState({ currentProjectPath: '/ws' })
    mockInvoke.mockResolvedValue(undefined)
    Object.assign(window, {
      api: { invoke: mockInvoke, on: vi.fn(() => () => {}), removeAllListeners: vi.fn() }
    })
    useAgentStore.getState().handlePermissionRequest(request)

    // Astryx DropdownMenu 用 Popover API 打开浮层；jsdom 未实现，按组件自带测试同款 polyfill
    HTMLElement.prototype.showPopover = vi.fn(function (this: HTMLElement) {
      this.setAttribute('popover-open', '')
      const event = new Event('toggle', { bubbles: false })
      Object.defineProperty(event, 'newState', { value: 'open' })
      this.dispatchEvent(event)
    })
    HTMLElement.prototype.hidePopover = vi.fn(function (this: HTMLElement) {
      this.removeAttribute('popover-open')
      const event = new Event('toggle', { bubbles: false })
      Object.defineProperty(event, 'newState', { value: 'closed' })
      this.dispatchEvent(event)
    })
    const originalMatches = HTMLElement.prototype.matches
    HTMLElement.prototype.matches = function (selector: string): boolean {
      if (selector === ':popover-open') return this.hasAttribute('popover-open')
      return originalMatches.call(this, selector)
    }
  })

  it('「本项目永久允许」规则写入失败时不放行，出现错误提示并保留弹条', async () => {
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === PERMISSION_UPSERT) throw new Error('规则落盘失败')
      return undefined
    })

    const renderer = renderDom(<InlinePermissionBar request={request} />)

    click(renderer.container.querySelector('[aria-haspopup="menu"]')!)
    const item = Array.from(renderer.container.querySelectorAll('[role="menuitem"]')).find(
      el => (el.textContent ?? '').includes('本项目永久允许')
    )
    expect(item).toBeTruthy()
    await act(async () => {
      item!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    // 规则写入失败：不 proceed（respond-permission 未发出），pending 请求原样保留
    const state = useAgentStore.getState()
    expect(mockInvoke).toHaveBeenCalledWith(
      PERMISSION_UPSERT,
      expect.objectContaining({ scope: 'project', behavior: 'allow' })
    )
    const respondCalls = mockInvoke.mock.calls.filter(([c]) => c === 'respond-permission')
    expect(respondCalls).toHaveLength(0)
    expect(state.pendingPermissionRequest?.requestId).toBe('req_1')
    expect(state.permissionError).toContain('保存持久化规则失败')
    expect(renderer.container.querySelector('.inline-perm__error')?.textContent).toContain(
      '保存持久化规则失败'
    )
    renderer.unmount()
  })

  it('「本会话允许」白名单写入失败时同样中止放行并提示', async () => {
    const grantCall = vi.fn().mockRejectedValue(new Error('会话作用域写入失败'))
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'permission:grant-session-scope') return grantCall()
      return undefined
    })

    const renderer = renderDom(<InlinePermissionBar request={request} />)

    click(renderer.container.querySelector('[aria-haspopup="menu"]')!)
    const item = Array.from(renderer.container.querySelectorAll('[role="menuitem"]')).find(
      el => (el.textContent ?? '').includes('本会话允许')
    )
    expect(item).toBeTruthy()
    await act(async () => {
      item!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    const state = useAgentStore.getState()
    const respondCalls = mockInvoke.mock.calls.filter(([c]) => c === 'respond-permission')
    expect(respondCalls).toHaveLength(0)
    expect(state.pendingPermissionRequest?.requestId).toBe('req_1')
    expect(state.permissionError).toContain('写入本会话白名单失败')
    expect(renderer.container.querySelector('.inline-perm__error')?.textContent).toContain(
      '写入本会话白名单失败'
    )
    renderer.unmount()
  })

  it('高风险 shell_session 请求只保留带输入前缀的始终拒绝', async () => {
    const renderer = renderDom(
      <InlinePermissionBar request={{
        ...request,
        toolName: 'shell_session',
        args: { action: 'write', ref: 'proc-1', input: 'sudo reboot' },
        riskLevel: 'high'
      }} />
    )

    const menuButton = renderer.container.querySelector('[aria-haspopup="menu"]')
    expect(menuButton?.getAttribute('aria-label')).toContain('拒绝')
    click(menuButton!)
    const labels = Array.from(renderer.container.querySelectorAll('[role="menuitem"]'))
      .map(item => item.textContent ?? '')

    expect(labels.some(label => label.includes('始终拒绝执行'))).toBe(true)
    expect(labels.some(label => label.includes('本会话允许'))).toBe(false)
    expect(labels.some(label => label.includes('本项目永久允许'))).toBe(false)
    expect(labels.some(label => label.includes('全局永久允许'))).toBe(false)
    expect(renderer.container.textContent).toContain('允许一次')

    const denyItem = Array.from(renderer.container.querySelectorAll('[role="menuitem"]')).find(
      item => (item.textContent ?? '').includes('始终拒绝执行')
    )
    await act(async () => {
      denyItem!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    expect(mockInvoke).toHaveBeenCalledWith(
      PERMISSION_UPSERT,
      expect.objectContaining({
        toolName: 'shell_session',
        behavior: 'deny',
        commandPrefix: 'sudo'
      })
    )
    renderer.unmount()
  })

  it('工作区外访问展示路径，并提供允许一次与本会话允许此目录', () => {
    const pathRequest: PendingPermissionRequest = {
      ...request,
      toolName: 'read',
      args: { path: 'C:\\Users\\x\\.config\\foo' },
      reason: '需要访问工作区外文件',
      externalPaths: ['C:\\Users\\x\\.config\\foo'],
      pathAccess: 'read'
    }
    const renderer = renderDom(<InlinePermissionBar request={pathRequest} />)
    const text = renderer.container.textContent ?? ''
    expect(text).toContain('需要访问工作区外文件')
    expect(text).toContain('C:\\Users\\x\\.config\\foo')
    expect(text).toContain('读取')
    expect(text).toContain('拒绝')
    expect(text).toContain('允许一次')
    expect(text).toContain('本会话允许此目录')
    expect(renderer.container.querySelector('[aria-haspopup="menu"]')).toBeNull()
    renderer.unmount()
  })

  it('本会话允许此目录写入失败时不放行', async () => {
    const pathRequest: PendingPermissionRequest = {
      ...request,
      toolName: 'read',
      args: { path: '/tmp/outside.txt' },
      externalPaths: ['/tmp/outside.txt'],
      pathAccess: 'read'
    }
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === PERMISSION_GRANT_SESSION_PATH) throw new Error('目录授权失败')
      return undefined
    })

    const renderer = renderDom(<InlinePermissionBar request={pathRequest} />)
    const grantBtn = Array.from(renderer.container.querySelectorAll('button')).find(
      el => (el.textContent ?? '').includes('本会话允许此目录')
    )
    expect(grantBtn).toBeTruthy()
    await act(async () => {
      grantBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    const respondCalls = mockInvoke.mock.calls.filter(([c]) => c === 'respond-permission')
    expect(respondCalls).toHaveLength(0)
    expect(useAgentStore.getState().pendingPermissionRequest?.requestId).toBe('req_1')
    expect(useAgentStore.getState().permissionError).toContain('写入本会话目录授权失败')
    renderer.unmount()
  })

  it('本会话允许此目录写入请求所属会话，而不是当前聊天会话', async () => {
    const pathRequest: PendingPermissionRequest = {
      ...request,
      sessionId: 'child-session',
      toolName: 'read',
      externalPaths: ['/tmp/outside.txt'],
      pathAccess: 'read'
    }
    useChatStore.setState({ currentSessionId: 'parent-session' })

    const renderer = renderDom(<InlinePermissionBar request={pathRequest} />)
    const grantBtn = Array.from(renderer.container.querySelectorAll('button')).find(
      el => (el.textContent ?? '').includes('本会话允许此目录')
    )
    await act(async () => {
      grantBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mockInvoke).toHaveBeenCalledWith(
      PERMISSION_GRANT_SESSION_PATH,
      expect.objectContaining({ sessionId: 'child-session' })
    )
    renderer.unmount()
  })

  it('多路径请求逐条展示，并对全部路径写入本会话目录授权后才放行', async () => {
    const paths = ['/tmp/a.txt', '/tmp/b.txt', '/opt/c.txt', '/opt/d.txt', '/var/e.txt']
    const pathRequest: PendingPermissionRequest = {
      ...request,
      toolName: 'write',
      args: { path: paths[0] },
      externalPaths: paths,
      pathAccess: 'write'
    }
    const renderer = renderDom(<InlinePermissionBar request={pathRequest} />)

    // 折叠：先显示前 3 条，展开后全部可见
    expect(renderer.container.textContent).not.toContain('/var/e.txt')
    const expand = Array.from(renderer.container.querySelectorAll('button')).find(
      el => (el.textContent ?? '').includes('展开其余 2 条')
    )
    click(expand!)
    for (const path of paths) expect(renderer.container.textContent).toContain(path)

    const grantBtn = Array.from(renderer.container.querySelectorAll('button')).find(
      el => (el.textContent ?? '').includes('本会话允许这些目录')
    )
    await act(async () => {
      grantBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      for (let i = 0; i < paths.length + 2; i += 1) await Promise.resolve()
    })

    const grantCalls = mockInvoke.mock.calls.filter(([c]) => c === PERMISSION_GRANT_SESSION_PATH)
    expect(grantCalls.map(([, params]) => params)).toEqual(
      paths.map(canonicalPath => ({
        sessionId: 'sess_1',
        requestId: 'req_1',
        canonicalPath,
        access: 'write'
      }))
    )
    const channels = mockInvoke.mock.calls.map(([c]) => c)
    const lastGrantIndex = channels.lastIndexOf(PERMISSION_GRANT_SESSION_PATH)
    expect(channels.indexOf('respond-permission')).toBeGreaterThan(lastGrantIndex)
    renderer.unmount()
  })

  it('授权条自身列出本次要批准的全部命令', () => {
    const renderer = renderDom(
      <InlinePermissionBar request={{
        ...request,
        args: {},
        commands: ['npm install', 'git push origin main --force-with-lease']
      }} />
    )
    const list = renderer.container.querySelector('[aria-label="本次授权命令"]')
    const items = Array.from(list?.querySelectorAll('code') ?? []).map(el => el.textContent)
    expect(items).toEqual(['npm install', 'git push origin main --force-with-lease'])
    renderer.unmount()
  })
})
