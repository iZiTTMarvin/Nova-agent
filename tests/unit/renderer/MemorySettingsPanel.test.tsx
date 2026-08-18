// @vitest-environment jsdom

/**
 * MemorySettingsPanel 学习记忆查看器：列表渲染、Project/Global 切换、忘记交互。
 * preload 桥接以 window.api mock 替代（仓库 renderer 测试惯例），断言走真实组件状态。
 */
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemorySettingsPanel } from '../../../src/renderer/features/settings/MemorySettingsPanel'
import type { MemoryRecordDto, MemoryScopeFileEntry } from '../../../src/shared/memory/types'
import { renderDom, act } from './renderDom'

const mockInvoke = vi.fn()

function recordDto(overrides: Partial<MemoryRecordDto> = {}): MemoryRecordDto {
  return {
    id: 'mem_1',
    scopeKind: 'project',
    kind: 'decision',
    memoryKey: 'database.primary',
    content: '项目当前主要数据库为 PostgreSQL',
    status: 'active',
    explicitness: 'workspace_verified',
    evidenceCount: 2,
    sourceSummary: '来自工作区',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_500_000,
    ...overrides
  }
}

const settingsDto = {
  loadThirdPartySkills: true,
  defaultMode: 'default',
  permissionPolicy: 'ask',
  defaultShell: '',
  defaultShellTimeout: 120_000,
  maxToolRounds: 100,
  editorFontSize: 13,
  editorFontFamily: 'monospace',
  theme: 'system',
  diffAutoExpand: false,
  lastProjectPath: '/tmp/project',
  snapshotRetentionDays: 30,
  memoryEnabled: true,
  memorySearchLimit: 10,
  memoryScoreFloor: 0.15,
  memoryReconcileOnSearch: false,
  memoryCaptureEnabled: true,
  memoryEpisodicSummaryEnabled: true,
  memoryExtractEnabled: true
}

function flushAsync(): Promise<void> {
  return act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

function setupInvokeMock(options: {
  files?: MemoryScopeFileEntry[]
  projectRecords?: MemoryRecordDto[]
  globalRecords?: MemoryRecordDto[]
} = {}) {
  const files = options.files ?? []
  const projectRecords = options.projectRecords ?? [recordDto()]
  const globalRecords = options.globalRecords ?? []
  mockInvoke.mockReset()
  mockInvoke.mockImplementation((channel: string, params?: { scopeKind?: string }) => {
    if (channel === 'settings:get') return Promise.resolve(settingsDto)
    if (channel === 'memory:list-files') return Promise.resolve(files)
    if (channel === 'memory:read-file') return Promise.resolve('# Project memory')
    if (channel === 'memory:stats') {
      return Promise.resolve({
        scopeId: 'abc',
        scopeDir: '/tmp/memory/abc',
        fileCount: 1,
        indexCount: 1,
        diskBytes: 10,
        records: { active: projectRecords.length, pending: 0, superseded: 0, retracted: 0, needsVerification: 0 }
      })
    }
    if (channel === 'memory:list-records') {
      return Promise.resolve(params?.scopeKind === 'global' ? globalRecords : projectRecords)
    }
    if (channel === 'memory:retract-record') return Promise.resolve(undefined)
    return Promise.resolve(undefined)
  })
}

describe('MemorySettingsPanel 学习记忆查看器', () => {
  beforeEach(() => {
    const escapeCss = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
    if (typeof CSS === 'undefined') {
      Object.defineProperty(globalThis, 'CSS', {
        configurable: true,
        value: { escape: escapeCss }
      })
    } else {
      Object.defineProperty(CSS, 'escape', {
        configurable: true,
        value: escapeCss
      })
    }
    Object.defineProperty(window, 'scrollTo', {
      configurable: true,
      value: vi.fn()
    })
    if (typeof HTMLDialogElement !== 'undefined') {
      Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
        configurable: true,
        value() {
          this.open = true
        }
      })
      Object.defineProperty(HTMLDialogElement.prototype, 'close', {
        configurable: true,
        value() {
          this.open = false
        }
      })
    }
    // 就地替换 bridge（与仓库其他 renderer 测试一致）
    global.window.api = {
      invoke: mockInvoke,
      on: vi.fn(() => () => {}),
      removeAllListeners: vi.fn()
    } as never
    // useSettingsStore 的 currentProject 决定 project scope 可用性
  })

  it('默认展示项目记忆：kind 标签、可信度标识、来源摘要与忘记按钮', async () => {
    setupInvokeMock()
    const { useSettingsStore } = await import('../../../src/renderer/stores/useSettingsStore')
    useSettingsStore.setState({ currentProject: '/tmp/project' })

    const renderer = renderDom(<MemorySettingsPanel />)
    await flushAsync()

    const text = renderer.container.textContent ?? ''
    expect(text).toContain('已学习的记忆')
    expect(text).toContain('决策')
    expect(text).toContain('项目当前主要数据库为 PostgreSQL')
    expect(text).toContain('已由工作区确认')
    expect(text).toContain('来源：工作区')
    expect(text).toContain('技术信息')
    expect(text).toContain('database.primary')
    expect(renderer.container.querySelector('.memory-settings-panel__forget-btn')).not.toBeNull()
    renderer.unmount()
  })

  it('observed 记忆显示可读学习来源', async () => {
    setupInvokeMock({
      projectRecords: [recordDto({ id: 'mem_obs', explicitness: 'observed', kind: 'preference', memoryKey: null })]
    })
    const { useSettingsStore } = await import('../../../src/renderer/stores/useSettingsStore')
    useSettingsStore.setState({ currentProject: '/tmp/project' })

    const renderer = renderDom(<MemorySettingsPanel />)
    await flushAsync()

    const text = renderer.container.textContent ?? ''
    expect(text).toContain('根据操作记录学习')
    expect(renderer.container.querySelector('.memory-settings-panel__record-meta')).not.toBeNull()
    renderer.unmount()
  })

  it('记忆文件在主页面折叠为摘要，点击后打开编辑浮窗', async () => {
    setupInvokeMock({
      files: [
        { relPath: 'MEMORY.md', size: 1024, mtimeMs: 1_700_000_000_000 },
        { relPath: 'episodic/summary.md', size: 2048, mtimeMs: 1_700_000_500_000 }
      ]
    })
    const { useSettingsStore } = await import('../../../src/renderer/stores/useSettingsStore')
    useSettingsStore.setState({ currentProject: '/tmp/project' })

    const renderer = renderDom(<MemorySettingsPanel />)
    await flushAsync()

    expect(renderer.container.querySelector('.memory-file-dialog')).toBeNull()

    const editButton = [...renderer.container.querySelectorAll('button')].find(
      b => b.textContent === '编辑文件'
    )
    expect(editButton).toBeDefined()

    await act(async () => {
      editButton!.click()
    })
    await flushAsync()

    expect(renderer.container.querySelector('.memory-file-dialog')).not.toBeNull()
    expect(renderer.container.textContent ?? '').toContain('编辑记忆文件')
    renderer.unmount()
  })

  it('切换到全局视图：请求 global scope 并展示全局记忆', async () => {
    setupInvokeMock({
      projectRecords: [],
      globalRecords: [recordDto({ id: 'mem_g', scopeKind: 'global', kind: 'convention', content: 'commit 使用 feat:/fix: 风格' })]
    })
    const { useSettingsStore } = await import('../../../src/renderer/stores/useSettingsStore')
    useSettingsStore.setState({ currentProject: '/tmp/project' })

    const renderer = renderDom(<MemorySettingsPanel />)
    await flushAsync()

    const globalButton = [...renderer.container.querySelectorAll('button')].find(
      b => b.textContent === '全局'
    )
    expect(globalButton).toBeDefined()
    await act(async () => {
      globalButton!.click()
    })
    await flushAsync()

    const listCalls = mockInvoke.mock.calls.filter(c => c[0] === 'memory:list-records')
    expect(listCalls.some(c => (c[1] as { scopeKind?: string })?.scopeKind === 'global')).toBe(true)
    expect(renderer.container.textContent ?? '').toContain('commit 使用 feat:/fix: 风格')
    renderer.unmount()
  })

  it('忘记：调用 retract IPC 成功后记录即时从列表移除', async () => {
    setupInvokeMock({ projectRecords: [recordDto(), recordDto({ id: 'mem_2', content: '包管理器使用 pnpm' })] })
    const { useSettingsStore } = await import('../../../src/renderer/stores/useSettingsStore')
    useSettingsStore.setState({ currentProject: '/tmp/project' })

    const renderer = renderDom(<MemorySettingsPanel />)
    await flushAsync()

    const forgetButtons = [...renderer.container.querySelectorAll('.memory-settings-panel__forget-btn')]
    expect(forgetButtons).toHaveLength(2)

    await act(async () => {
      forgetButtons[0].click()
    })
    await flushAsync()

    const retractCalls = mockInvoke.mock.calls.filter(c => c[0] === 'memory:retract-record')
    expect(retractCalls).toHaveLength(1)
    expect(retractCalls[0][1]).toEqual({ id: 'mem_1', scopeKind: 'project' })

    const text = renderer.container.textContent ?? ''
    expect(text).not.toContain('项目当前主要数据库为 PostgreSQL')
    expect(text).toContain('包管理器使用 pnpm')
    renderer.unmount()
  })

  it('忘记失败：记录保留并展示可理解错误', async () => {
    setupInvokeMock()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'memory:retract-record') return Promise.reject(new Error('无权操作其他范围的记忆'))
      if (channel === 'settings:get') return Promise.resolve(settingsDto)
      if (channel === 'memory:list-files') return Promise.resolve([])
      if (channel === 'memory:stats') {
        return Promise.resolve({
          scopeId: 'abc',
          scopeDir: '/tmp',
          fileCount: 0,
          indexCount: 0,
          diskBytes: 0,
          records: { active: 1, pending: 0, superseded: 0, retracted: 0, needsVerification: 0 }
        })
      }
      if (channel === 'memory:list-records') return Promise.resolve([recordDto()])
      return Promise.resolve(undefined)
    })
    const { useSettingsStore } = await import('../../../src/renderer/stores/useSettingsStore')
    useSettingsStore.setState({ currentProject: '/tmp/project' })

    const renderer = renderDom(<MemorySettingsPanel />)
    await flushAsync()

    const forgetButton = renderer.container.querySelector('.memory-settings-panel__forget-btn') as HTMLButtonElement
    await act(async () => {
      forgetButton.click()
    })
    await flushAsync()

    const text = renderer.container.textContent ?? ''
    expect(text).toContain('无权操作其他范围的记忆')
    expect(text).toContain('项目当前主要数据库为 PostgreSQL')
    renderer.unmount()
  })

  it('记忆总开关保留；autoMerge 开关不再渲染', async () => {
    setupInvokeMock()
    const { useSettingsStore } = await import('../../../src/renderer/stores/useSettingsStore')
    useSettingsStore.setState({ currentProject: '/tmp/project' })

    const renderer = renderDom(<MemorySettingsPanel />)
    await flushAsync()

    const text = renderer.container.textContent ?? ''
    expect(text).toContain('启用跨会话记忆')
    expect(text).not.toContain('自动合并到 MEMORY.md')
    renderer.unmount()
  })
})
