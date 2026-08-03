// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ModeSwitch } from '../../../src/renderer/features/mode-switch/ModeSwitch'
import { useSettingsStore } from '../../../src/renderer/stores/useSettingsStore'
import { act, renderDom } from './renderDom'

vi.mock('framer-motion', () => import('./_framerMotionMock'))

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(element =>
    element.textContent?.includes(label)
  )
  if (!button) throw new Error(`button not found: ${label}`)
  return button
}

describe('ModeSwitch 工作流菜单', () => {
  beforeEach(() => {
    useSettingsStore.setState({ currentMode: 'default' })
    vi.clearAllMocks()
  })

  it('通过加号统一展示模式、图片与技能入口', () => {
    const onSelectImage = vi.fn()
    const onSelectSkills = vi.fn()
    const renderer = renderDom(
      <ModeSwitch
        supportsVision
        onSelectImage={onSelectImage}
        onSelectSkills={onSelectSkills}
      />
    )

    act(() => {
      renderer.container.querySelector<HTMLButtonElement>('[aria-label="添加工作流、上下文与工具"]')?.click()
    })

    expect(findButton(renderer.container, '计划模式')).toBeDefined()
    expect(findButton(renderer.container, 'XForge')).toBeDefined()
    expect(findButton(renderer.container, '添加图片')).toBeDefined()
    expect(findButton(renderer.container, '技能与命令')).toBeDefined()

    act(() => {
      findButton(renderer.container, '添加图片').click()
    })
    expect(onSelectImage).toHaveBeenCalledTimes(1)
    renderer.unmount()
  })

  it('默认模式只显示加号，不显示常驻模式标签', () => {
    const renderer = renderDom(<ModeSwitch />)

    expect(
      renderer.container.querySelectorAll('[data-testid="active-mode-chip"]')
    ).toHaveLength(0)
    expect(
      renderer.container.querySelector('[aria-label="添加工作流、上下文与工具"]')
    ).not.toBeNull()
    renderer.unmount()
  })

  it('选择 Plan 使用现有会话模式真源并关闭菜单', async () => {
    const originalSetMode = useSettingsStore.getState().setMode
    const setMode = vi.fn(async () => {
      useSettingsStore.setState({ currentMode: 'plan' })
    })
    useSettingsStore.setState({ setMode })

    try {
      const renderer = renderDom(<ModeSwitch />)
      act(() => {
        renderer.container.querySelector<HTMLButtonElement>('[aria-label="添加工作流、上下文与工具"]')?.click()
      })
      await act(async () => {
        findButton(renderer.container, '计划模式').click()
        await Promise.resolve()
      })

      expect(setMode).toHaveBeenCalledWith('plan')
      expect(useSettingsStore.getState().currentMode).toBe('plan')
      expect(renderer.container.querySelector('[data-testid="active-mode-chip"]')).not.toBeNull()
      renderer.unmount()
    } finally {
      useSettingsStore.setState({ setMode: originalSetMode })
    }
  })

  it('Plan 标签可通过关闭按钮返回默认模式', async () => {
    const originalSetMode = useSettingsStore.getState().setMode
    const setMode = vi.fn(async (mode: 'default' | 'plan' | 'compose') => {
      useSettingsStore.setState({ currentMode: mode })
    })
    useSettingsStore.setState({ currentMode: 'plan', setMode })

    try {
      const renderer = renderDom(<ModeSwitch />)

      expect(renderer.container.querySelector('[data-testid="active-mode-chip"]')).not.toBeNull()
      await act(async () => {
        renderer.container.querySelector<HTMLButtonElement>('[aria-label="退出 Plan"]')?.click()
        await Promise.resolve()
      })

      expect(setMode).toHaveBeenCalledWith('default')
      expect(useSettingsStore.getState().currentMode).toBe('default')
      expect(
        renderer.container.querySelectorAll('[data-testid="active-mode-chip"]')
      ).toHaveLength(0)
      renderer.unmount()
    } finally {
      useSettingsStore.setState({ setMode: originalSetMode })
    }
  })
})
