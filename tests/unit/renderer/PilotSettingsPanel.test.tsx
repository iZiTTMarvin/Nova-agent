// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PilotSettingsPanel } from '../../../src/renderer/features/settings/PilotSettingsPanel'
import { useSettingsStore, resetSettingsStoreForTests } from '../../../src/renderer/stores/useSettingsStore'
import { createSkillId } from '../../../src/shared/skills/identity'
import type { SkillSummary } from '../../../src/shared/skills/types'
import { renderDom, act } from './renderDom'

const mockInvoke = vi.fn()

const sampleSkill1: SkillSummary = {
  skillId: createSkillId({ name: 'frontend-design', source: 'builtin', sourcePath: '/builtin/frontend-design' }),
  name: 'frontend-design',
  description: '前端界面与交互设计',
  source: 'builtin',
  sourcePath: '/builtin/frontend-design',
  userInvocable: true,
  modelInvocable: true,
  warnings: [],
  bodyPreview: '',
  hasSupportingFiles: false
}

const sampleSkill2: SkillSummary = {
  skillId: createSkillId({ name: 'api-spec', source: 'project', sourcePath: '/project/.nova/skills/api-spec' }, '/project'),
  name: 'api-spec',
  description: 'API 接口规约',
  source: 'project',
  sourcePath: '/project/.nova/skills/api-spec',
  userInvocable: true,
  modelInvocable: true,
  warnings: [],
  bodyPreview: '',
  hasSupportingFiles: false
}

const staleSkillId = createSkillId({ name: 'deleted-skill', source: 'project', sourcePath: '/project/.nova/skills/deleted' }, '/project')

function flushAsync(): Promise<void> {
  return act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

describe('PilotSettingsPanel 领航模式设置面板', () => {
  beforeEach(() => {
    resetSettingsStoreForTests()
    mockInvoke.mockReset()
    mockInvoke.mockImplementation((channel: string, payload?: unknown) => {
      if (channel === 'settings:get') {
        return Promise.resolve({
          pilotSkillIds: [sampleSkill1.skillId, staleSkillId],
          pilotSkillGuideSeen: false
        })
      }
      if (channel === 'settings:set') {
        return Promise.resolve(payload)
      }
      return Promise.resolve(undefined)
    })

    global.window.api = {
      invoke: mockInvoke,
      on: vi.fn(() => () => {}),
      removeAllListeners: vi.fn()
    } as never

    global.window.nova = {
      skill: {
        list: vi.fn((query?: { mode?: string }) => {
          return Promise.resolve({
            skills: [sampleSkill1, sampleSkill2],
            loading: false,
            error: null,
            refreshedAt: Date.now(),
            diagnostics: [],
            thirdPartySources: []
          })
        }),
        onChange: vi.fn(() => () => {})
      }
    } as never
  })

  it('首次进入时展示领航推荐 Banner 并异步标记已阅', async () => {
    const { container, unmount } = renderDom(<PilotSettingsPanel />)
    await flushAsync()

    expect(window.nova.skill.list).toHaveBeenCalledWith({ mode: 'default' })
    expect(mockInvoke).toHaveBeenCalledWith('settings:get')
    expect(mockInvoke).toHaveBeenCalledWith('settings:set', { pilotSkillGuideSeen: true })

    expect(container.textContent).toContain('领航模式技能推荐')
    expect(container.textContent).toContain('建议加入前端设计、框架知识等领域技能')
    unmount()
  })

  it('展示候选技能与 Switch 勾选状态，点击 Switch 保存更新', async () => {
    const { container, unmount } = renderDom(<PilotSettingsPanel />)
    await flushAsync()

    // 两个技能的名称
    expect(container.textContent).toContain('/frontend-design')
    expect(container.textContent).toContain('/api-spec')

    // Switches
    const switches = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    expect(switches.length).toBeGreaterThanOrEqual(2)
    // sampleSkill1 在 pilotSkillIds 中，应为 checked
    expect(switches[0].checked).toBe(true)
    // sampleSkill2 不在 pilotSkillIds 中，应为 unchecked
    expect(switches[1].checked).toBe(false)

    // 勾选 sampleSkill2
    await act(async () => {
      switches[1].click()
    })

    expect(mockInvoke).toHaveBeenCalledWith('settings:set', {
      pilotSkillIds: expect.arrayContaining([sampleSkill1.skillId, sampleSkill2.skillId, staleSkillId])
    })
    unmount()
  })

  it('识别已失效的技能并在独立区块展示，点击「移除」将其清理', async () => {
    const { container, unmount } = renderDom(<PilotSettingsPanel />)
    await flushAsync()

    expect(container.textContent).toContain('已失效的技能选择')
    expect(container.textContent).toContain('/deleted-skill')
    expect(container.textContent).toContain('不可用')

    const removeButton = Array.from(container.querySelectorAll('button')).find(
      btn => btn.textContent?.includes('移除')
    )
    expect(removeButton).toBeDefined()

    await act(async () => {
      removeButton!.click()
    })

    expect(mockInvoke).toHaveBeenCalledWith('settings:set', {
      pilotSkillIds: [sampleSkill1.skillId]
    })
    unmount()
  })

  it('空候选列表时展示空态说明与前往技能管理入口', async () => {
    vi.mocked(window.nova.skill.list).mockResolvedValueOnce({
      skills: [],
      loading: false,
      error: null,
      refreshedAt: Date.now(),
      diagnostics: [],
      thirdPartySources: []
    })

    const { container, unmount } = renderDom(<PilotSettingsPanel />)
    await flushAsync()

    expect(container.textContent).toContain('当前工作区未检测到可用技能')
    const selectButton = Array.from(container.querySelectorAll('button')).find(
      btn => btn.textContent?.includes('选择技能')
    )
    expect(selectButton).toBeDefined()

    await act(async () => {
      selectButton!.click()
    })

    expect(useSettingsStore.getState().isConfigModalOpen).toBe(true)
    expect(useSettingsStore.getState().requestedSettingsSection).toBe('skills')
    unmount()
  })
})
