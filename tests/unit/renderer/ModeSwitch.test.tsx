import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ModeSwitch } from '../../../src/renderer/features/mode-switch/ModeSwitch'
import { useSettingsStore } from '../../../src/renderer/stores/useSettingsStore'

global.document = {
  addEventListener: vi.fn(),
  removeEventListener: vi.fn()
} as unknown as Document

function findButton(root: TestRenderer.ReactTestInstance, label: string) {
  return root.find(node =>
    node.type === 'button' &&
    node.findAll(child =>
      child.children.some(value => typeof value === 'string' && value.includes(label))
    ).length > 0
  )
}

describe('ModeSwitch 工作流菜单', () => {
  beforeEach(() => {
    useSettingsStore.setState({ currentMode: 'default' })
    vi.clearAllMocks()
  })

  it('通过加号统一展示模式、图片与技能入口', () => {
    const onSelectImage = vi.fn()
    const onSelectSkills = vi.fn()
    const renderer = TestRenderer.create(
      <ModeSwitch
        supportsVision
        onSelectImage={onSelectImage}
        onSelectSkills={onSelectSkills}
      />
    )

    act(() => {
      renderer.root.findByProps({ 'aria-label': '添加工作流、上下文与工具' }).props.onClick()
    })

    expect(findButton(renderer.root, '计划模式')).toBeDefined()
    expect(findButton(renderer.root, 'XForge')).toBeDefined()
    expect(findButton(renderer.root, '添加图片')).toBeDefined()
    expect(findButton(renderer.root, '技能与命令')).toBeDefined()

    act(() => {
      findButton(renderer.root, '添加图片').props.onClick()
    })
    expect(onSelectImage).toHaveBeenCalledTimes(1)
  })

  it('默认模式只显示加号，不显示常驻模式标签', () => {
    const renderer = TestRenderer.create(<ModeSwitch />)

    expect(
      renderer.root.findAllByProps({ 'data-testid': 'active-mode-chip' })
    ).toHaveLength(0)
    expect(
      renderer.root.findByProps({ 'aria-label': '添加工作流、上下文与工具' })
    ).toBeDefined()
  })

  it('选择 Plan 使用现有会话模式真源并关闭菜单', async () => {
    const originalSetMode = useSettingsStore.getState().setMode
    const setMode = vi.fn(async () => {
      useSettingsStore.setState({ currentMode: 'plan' })
    })
    useSettingsStore.setState({ setMode })

    try {
      const renderer = TestRenderer.create(<ModeSwitch />)
      act(() => {
        renderer.root.findByProps({ 'aria-label': '添加工作流、上下文与工具' }).props.onClick()
      })
      await act(async () => {
        await findButton(renderer.root, '计划模式').props.onClick()
      })

      expect(setMode).toHaveBeenCalledWith('plan')
      expect(useSettingsStore.getState().currentMode).toBe('plan')
      expect(renderer.root.findByProps({ 'data-testid': 'active-mode-chip' })).toBeDefined()
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
      const renderer = TestRenderer.create(<ModeSwitch />)

      expect(renderer.root.findByProps({ 'data-testid': 'active-mode-chip' })).toBeDefined()
      await act(async () => {
        await renderer.root.findByProps({ 'aria-label': '退出 Plan' }).props.onClick({
          stopPropagation: vi.fn()
        })
      })

      expect(setMode).toHaveBeenCalledWith('default')
      expect(useSettingsStore.getState().currentMode).toBe('default')
      expect(
        renderer.root.findAllByProps({ 'data-testid': 'active-mode-chip' })
      ).toHaveLength(0)
    } finally {
      useSettingsStore.setState({ setMode: originalSetMode })
    }
  })
})
