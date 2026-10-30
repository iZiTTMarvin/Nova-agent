// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmModelPicker } from '../../../src/renderer/features/settings/LlmModelPicker'
import { useSettingsStore, resetSettingsStoreForTests } from '../../../src/renderer/stores/useSettingsStore'
import { renderDom, act, waitFor } from './renderDom'

const provider = {
  id: 'custom-1',
  name: 'cmd',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-***abc',
  models: [{ id: 'm-1', modelId: 'gpt-6-luna' }]
}

describe('LlmModelPicker 获取可用模型', () => {
  beforeEach(() => {
    resetSettingsStoreForTests()
    // Astryx Dialog 依赖 CSS.escape 与 window.scrollTo，jsdom 均未实现
    Object.defineProperty(window, 'scrollTo', { configurable: true, value: vi.fn() })
    const escapeCss = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
    if (typeof CSS === 'undefined') {
      Object.defineProperty(globalThis, 'CSS', { configurable: true, value: { escape: escapeCss } })
    } else {
      Object.defineProperty(CSS, 'escape', { configurable: true, value: escapeCss })
    }
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value() { this.open = true }
    })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value() { this.open = false }
    })
  })

  it('新模型默认不勾选、已添加模型锁定，确认时只返回用户勾选的新模型', async () => {
    const fetchProviderModels = vi.fn().mockResolvedValue({
      ok: true,
      modelIds: ['gpt-6-luna', 'claude-haiku-5-5', 'glm-5.3-flash']
    })
    useSettingsStore.setState({ fetchProviderModels })
    const onConfirm = vi.fn()
    const { unmount } = renderDom(
      <LlmModelPicker provider={provider} onClose={() => {}} onConfirm={onConfirm} />
    )
    await waitFor(() => document.querySelectorAll('.llm-picker__row').length === 3)

    // 请求带上服务商 id，主进程才能把掩码 key 还原为已保存的密钥
    expect(fetchProviderModels).toHaveBeenCalledWith('https://api.example.com/v1', 'sk-***abc', 'custom-1')

    const inputs = [...document.querySelectorAll<HTMLInputElement>('.llm-picker__input')]
    expect(inputs.map(i => [i.checked, i.disabled])).toEqual([
      [true, true],
      [false, false],
      [false, false]
    ])
    const confirmButton = [...document.querySelectorAll('button')].find(b => b.textContent?.startsWith('添加所选'))!
    expect(confirmButton.disabled).toBe(true)

    act(() => { inputs[2].click() })
    expect(confirmButton.disabled).toBe(false)
    act(() => { confirmButton.click() })

    expect(onConfirm).toHaveBeenCalledWith(['glm-5.3-flash'])
    unmount()
  })

  it('拉取失败时展示错误并可重试', async () => {
    const fetchProviderModels = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, message: '拉取失败 (401)' })
      .mockResolvedValueOnce({ ok: true, modelIds: ['glm-5.3-flash'] })
    useSettingsStore.setState({ fetchProviderModels })
    const { unmount } = renderDom(
      <LlmModelPicker provider={provider} onClose={() => {}} onConfirm={() => {}} />
    )
    await waitFor(() => document.querySelector('.llm-picker__notice') !== null)
    expect(document.querySelector('.llm-picker__notice')?.textContent).toContain('拉取失败 (401)')

    const retry = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === '重试')!
    act(() => { retry.click() })
    await waitFor(() => document.querySelectorAll('.llm-picker__row').length === 1)
    expect(fetchProviderModels).toHaveBeenCalledTimes(2)
    unmount()
  })
})
