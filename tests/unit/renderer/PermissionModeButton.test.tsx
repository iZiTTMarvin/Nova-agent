// @vitest-environment jsdom

import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { PermissionModeButton } from '../../../src/renderer/features/permissions/PermissionModeButton'
import { act, renderDom } from './renderDom'

function openMenu(container: HTMLElement): void {
  const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')
  if (!trigger) throw new Error('permission mode trigger not found')
  act(() => trigger.click())
}

describe('PermissionModeButton', () => {
  it('会话切换后立即显示该会话自己的权限模式', () => {
    const onChange = vi.fn()
    const renderer = renderDom(
      <PermissionModeButton permissionMode="request_approval" onChange={onChange} />
    )
    expect(renderer.container.querySelector('[aria-haspopup="menu"]')?.textContent).toContain('请求批准')

    renderer.render(<PermissionModeButton permissionMode="auto" onChange={onChange} />)
    expect(renderer.container.querySelector('[aria-haspopup="menu"]')?.textContent).toContain('自动')
    renderer.unmount()
  })

  it('运行中禁用入口，完成后可切换会话模式', async () => {
    const onChange = vi.fn(async () => {})
    const renderer = renderDom(
      <PermissionModeButton permissionMode="request_approval" isDisabled onChange={onChange} />
    )
    const disabledTrigger = renderer.container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')
    expect(disabledTrigger?.getAttribute('aria-disabled') === 'true' || disabledTrigger?.disabled).toBe(true)

    renderer.render(
      <PermissionModeButton permissionMode="request_approval" onChange={onChange} />
    )
    openMenu(renderer.container)
    const auto = Array.from(renderer.container.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find(item => item.textContent?.includes('自动'))
    await act(async () => {
      auto?.click()
      await Promise.resolve()
    })
    expect(onChange).toHaveBeenCalledWith('auto')
    renderer.unmount()
  })

  it('完全访问展示为即将可用且不可选择', () => {
    const onChange = vi.fn()
    const renderer = renderDom(
      <PermissionModeButton permissionMode="auto" onChange={onChange} />
    )
    openMenu(renderer.container)

    const fullAccess = Array.from(renderer.container.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find(item => item.textContent?.includes('完全访问'))
    expect(fullAccess?.textContent).toContain('即将可用')
    act(() => fullAccess?.click())
    expect(onChange).not.toHaveBeenCalled()
    renderer.unmount()
  })
})
