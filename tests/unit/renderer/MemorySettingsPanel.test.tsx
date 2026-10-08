// @vitest-environment jsdom

/**
 * MemorySettingsPanel 学习记忆查看器：列表渲染、Project/Global 切换、忘记交互。
 * preload 桥接以 window.api mock 替代（仓库 renderer 测试惯例），断言走真实组件状态。
 */
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemorySettingsPanel } from '../../../src/renderer/features/settings/MemorySettingsPanel'
import type { MemoryEntryDto, MemoryFileDto } from '../../../src/shared/memory/types'
import { renderDom, act } from './renderDom'

const mockInvoke = vi.fn()

function recordDto(overrides: Partial<MemoryEntryDto> = {}): MemoryEntryDto {
  return {
    id: 'mem_1',
    scopeKind: 'project',
    kind: 'decision',
    key: 'database.primary',
    text: '项目当前主要数据库为 PostgreSQL',
    location: 'topics',
    relPath: 'decisions.md',
    aliases: [],
    pinned: false,
    needsVerification: false,
    addedDate: '2023-11-14',
    explicitness: 'workspace_verified',
    evidenceCount: 2,

    lastSeenAt: 1_700_000_500_000,
    ...overrides
  }
}

const settingsDto = {
  loadThirdPartySkills: true,
  defaultMode: 'default',
  defaultPermissionMode: 'request_approval',
  defaultShell: '',
  persistentShellSessions: true,
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
  memoryAutoExtractEnabled: false
}

function flushAsync(): Promise<void> {
  return act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

function setupInvokeMock(options: {
  files?: MemoryFileDto[]
  projectRecords?: MemoryEntryDto[]
  globalRecords?: MemoryEntryDto[]
} = {}) {
  const files = options.files ?? []
  let projectRecords = options.projectRecords ?? [recordDto()]
  let globalRecords = options.globalRecords ?? []
  mockInvoke.mockReset()
  mockInvoke.mockImplementation((channel: string, params?: { scopeKind?: string; id?: string; pinned?: boolean; decision?: string }) => {
    if (channel === 'dialog:confirm') return Promise.resolve(1)
    if (channel === 'memory:snapshot-preview') return Promise.resolve({ text: 'preview fixture', globalCoreCount: 1, projectCoreCount: 2, omittedCoreCount: 0 })
    if (channel === 'memory:list-legacy') return Promise.resolve([])
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
        entries: { topics: projectRecords.length, inbox: 0, archive: 0 }, ledgerBadLines: 0
      })
    }
    if (channel === 'memory:list-entries') {
      return Promise.resolve(params?.scopeKind === 'global' ? globalRecords : projectRecords)
    }
    if (channel === 'memory:forget-entry') return Promise.resolve(undefined)
    if (channel === 'memory:set-entry-pinned' || channel === 'memory:decide-inbox') {
      const rows = params?.scopeKind === 'global' ? globalRecords : projectRecords
      const updated = rows.flatMap(row => row.id !== params?.id ? [row] : params?.decision === 'reject' ? [] : [{ ...row, pinned: params?.pinned ?? row.pinned, ...(params?.decision === 'approve' ? { location: 'topics' as const, explicitness: 'user_explicit' as const } : {}) }])
      if (params?.scopeKind === 'global') globalRecords = updated; else projectRecords = updated
      return Promise.resolve(undefined)
    }
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
    expect(text).toContain('证据 2 条')
    expect(text).toContain('技术信息')
    expect(text).toContain('database.primary')
    expect(renderer.container.querySelector('.memory-settings-panel__forget-btn')).not.toBeNull()
    renderer.unmount()
  })

  it('observed 记忆显示可读学习来源', async () => {
    setupInvokeMock({
      projectRecords: [recordDto({ id: 'mem_obs', explicitness: 'observed', kind: 'preference', key: null })]
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
        { relPath: 'MEMORY.md', size: 1024, mtimeMs: 1_700_000_000_000, managed: true, readOnly: true, parseIssues: 0, needsOrganization: false },
        { relPath: 'episodic/summary.md', size: 2048, mtimeMs: 1_700_000_500_000, managed: false, readOnly: false, parseIssues: 0, needsOrganization: false }
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
      globalRecords: [recordDto({ id: 'mem_g', scopeKind: 'global', kind: 'convention', text: 'commit 使用 feat:/fix: 风格' })]
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

    const listCalls = mockInvoke.mock.calls.filter(c => c[0] === 'memory:list-entries')
    expect(listCalls.some(c => (c[1] as { scopeKind?: string })?.scopeKind === 'global')).toBe(true)
    expect(renderer.container.textContent ?? '').toContain('commit 使用 feat:/fix: 风格')
    renderer.unmount()
  })

  it('忘记：调用 retract IPC 成功后记录即时从列表移除', async () => {
    setupInvokeMock({ projectRecords: [recordDto(), recordDto({ id: 'mem_2', text: '包管理器使用 pnpm' })] })
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

    const retractCalls = mockInvoke.mock.calls.filter(c => c[0] === 'memory:forget-entry')
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
      if (channel === 'memory:forget-entry') return Promise.reject(new Error('无权操作其他范围的记忆'))
      if (channel === 'dialog:confirm') return Promise.resolve(1)
    if (channel === 'memory:snapshot-preview') return Promise.resolve({ text: 'preview fixture', globalCoreCount: 1, projectCoreCount: 2, omittedCoreCount: 0 })
    if (channel === 'memory:list-legacy') return Promise.resolve([])
    if (channel === 'settings:get') return Promise.resolve(settingsDto)
      if (channel === 'memory:list-files') return Promise.resolve([])
      if (channel === 'memory:stats') {
        return Promise.resolve({
          scopeId: 'abc',
          scopeDir: '/tmp',
          fileCount: 0,
          indexCount: 0,
          diskBytes: 0,
          entries: { topics: 1, inbox: 0, archive: 0 }, ledgerBadLines: 0
        })
      }
      if (channel === 'memory:list-entries') return Promise.resolve([recordDto()])
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

  it('预览、默认关闭的自动学习、置顶与 inbox 决策走同一条目契约并刷新显示', async () => {
    setupInvokeMock({ projectRecords: [recordDto(), recordDto({ id: 'pending', location: 'inbox', relPath: 'inbox.md', text: '待批准的新约定', explicitness: 'observed' }), recordDto({ id: 'rejected', location: 'inbox', relPath: 'inbox.md', text: '应拒绝的候选' })] })
    const { useSettingsStore } = await import('../../../src/renderer/stores/useSettingsStore')
    useSettingsStore.setState({ currentProject: '/tmp/project' })
    const renderer = renderDom(<MemorySettingsPanel />); await flushAsync()
    expect(renderer.container.textContent).toContain('preview fixture')
    expect(renderer.container.textContent).toContain('全局 1 条 · 项目 2 条')
    const switches = [...renderer.container.querySelectorAll<HTMLInputElement>('input[role="switch"]')]
    expect(switches).toHaveLength(2)
    const auto = switches[1]
    expect(renderer.container.querySelector(`label[for="${CSS.escape(auto.id)}"]`)?.textContent).toContain('自动从对话中学习')
    expect(auto.checked).toBe(false)
    const click = async (label: string) => { const button = [...renderer.container.querySelectorAll('button')].find(item => item.textContent === label); expect(button).toBeDefined(); await act(async () => button!.click()); await flushAsync() }
    await click('置顶')
    expect(mockInvoke).toHaveBeenCalledWith('memory:set-entry-pinned', { scopeKind: 'project', id: 'mem_1', pinned: true })
    expect(renderer.container.textContent).toContain('已置顶')
    await click('批准')
    expect(mockInvoke).toHaveBeenCalledWith('memory:decide-inbox', { scopeKind: 'project', id: 'pending', decision: 'approve' })
    expect(renderer.container.textContent).toContain('你告诉我的')
    await click('拒绝')
    expect(mockInvoke).toHaveBeenCalledWith('memory:decide-inbox', { scopeKind: 'project', id: 'rejected', decision: 'reject' })
    expect(renderer.container.textContent).not.toContain('应拒绝的候选')
    renderer.unmount()
  })

  it('生成视图不可编辑；手写文件保存显示解析问题且拒绝确认时保留脏内容', async () => {
    setupInvokeMock({ files: [
      { relPath: 'MEMORY.md', size: 20, mtimeMs: 1, managed: true, readOnly: true, parseIssues: 0, needsOrganization: false },
      { relPath: 'notes.md', size: 20, mtimeMs: 1, managed: false, readOnly: false, parseIssues: 0, needsOrganization: false }
    ] })
    const implementation = mockInvoke.getMockImplementation()!
    mockInvoke.mockImplementation((channel: string, params: unknown) => channel === 'memory:write-file' ? Promise.resolve({ parseIssues: 2 }) : implementation(channel, params))
    const { useSettingsStore } = await import('../../../src/renderer/stores/useSettingsStore')
    useSettingsStore.setState({ currentProject: '/tmp/project' })
    const renderer = renderDom(<MemorySettingsPanel />); await flushAsync()
    const click = async (label: string) => { const button = [...renderer.container.querySelectorAll('button')].find(item => item.textContent === label); expect(button).toBeDefined(); await act(async () => button!.click()); await flushAsync() }
    await click('编辑文件')
    expect(renderer.container.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(true)
    const notes = [...renderer.container.querySelectorAll<HTMLButtonElement>('.memory-settings-panel__file-chip')].find(item => item.textContent?.startsWith('notes.md'))!
    await act(async () => notes.click()); await flushAsync()
    const textarea = renderer.container.querySelector<HTMLTextAreaElement>('textarea')!
    expect(textarea.disabled).toBe(false)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'new handwritten notes')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('保存')
    expect(mockInvoke).toHaveBeenCalledWith('memory:write-file', { scopeKind: 'project', relPath: 'notes.md', content: 'new handwritten notes' })
    expect(renderer.container.textContent).toContain('存在 2 个解析问题')
    mockInvoke.mockImplementation((channel: string, params: unknown) => channel === 'dialog:confirm' ? Promise.resolve(0) : implementation(channel, params))
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'unsaved local draft')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('全局')
    expect(textarea.value).toBe('unsaved local draft')
    expect(mockInvoke.mock.calls.filter(call => call[0] === 'memory:list-entries').every(call => call[1].scopeKind === 'project')).toBe(true)
    renderer.unmount()
  })

  it('范围切换后丢弃迟到的旧项目条目结果', async () => {
    setupInvokeMock({ globalRecords: [recordDto({ id: 'global', scopeKind: 'global', text: '当前全局约定' })] })
    const implementation = mockInvoke.getMockImplementation()!
    let resolveProject!: (rows: MemoryEntryDto[]) => void
    mockInvoke.mockImplementation((channel: string, params?: { scopeKind?: string }) => channel === 'memory:list-entries' && params?.scopeKind === 'project' ? new Promise<MemoryEntryDto[]>(resolve => { resolveProject = resolve }) : implementation(channel, params))
    const { useSettingsStore } = await import('../../../src/renderer/stores/useSettingsStore')
    useSettingsStore.setState({ currentProject: '/tmp/project' })
    const renderer = renderDom(<MemorySettingsPanel />); await flushAsync()
    const globalButton = [...renderer.container.querySelectorAll('button')].find(button => button.textContent === '全局')!
    await act(async () => globalButton.click()); await flushAsync()
    expect(renderer.container.textContent).toContain('当前全局约定')
    await act(async () => resolveProject([recordDto({ text: '迟到的旧项目结果' })])); await flushAsync()
    expect(renderer.container.textContent).toContain('当前全局约定')
    expect(renderer.container.textContent).not.toContain('迟到的旧项目结果')
    renderer.unmount()
  })

  it('手写含密钥时取消不保存、保留草稿；确认后保存原内容，确认框不泄露密钥', async () => {
    setupInvokeMock({ files: [{ relPath: 'notes.md', size: 1, mtimeMs: 1, managed: false, readOnly: false, parseIssues: 0, needsOrganization: false }] })
    const implementation = mockInvoke.getMockImplementation()!
    let response = 0
    mockInvoke.mockImplementation((channel: string, params: unknown) => channel === 'dialog:confirm' ? Promise.resolve(response) : implementation(channel, params))
    const { useSettingsStore } = await import('../../../src/renderer/stores/useSettingsStore')
    useSettingsStore.setState({ currentProject: '/tmp/project' })
    const renderer = renderDom(<MemorySettingsPanel />); await flushAsync()
    const click = async (label: string) => { const button = [...renderer.container.querySelectorAll('button')].find(item => item.textContent === label)!; await act(async () => button.click()); await flushAsync() }
    await click('编辑文件')
    const content = '手写数据 sk-ant-api03-' + 'TEST_ONLY_FAKE_'.repeat(4)
    const textarea = renderer.container.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, content); textarea.dispatchEvent(new Event('input', { bubbles: true })) })
    await click('保存')
    expect(mockInvoke.mock.calls.filter(row => row[0] === 'memory:write-file')).toEqual([])
    expect(textarea.value).toBe(content)
    const confirmation = mockInvoke.mock.calls.find(row => row[0] === 'dialog:confirm')![1]
    expect(confirmation).toMatchObject({ title: '记忆中可能含有密钥', defaultId: 0, cancelId: 0 })
    expect(JSON.stringify(confirmation)).not.toContain('sk-ant-api03-')
    response = 1
    await click('保存')
    expect(mockInvoke).toHaveBeenCalledWith('memory:write-file', { scopeKind: 'project', relPath: 'notes.md', content })
    renderer.unmount()
  })

  it('挂载后不按时间轮询记忆 IPC', async () => {
    setupInvokeMock()
    const { useSettingsStore } = await import('../../../src/renderer/stores/useSettingsStore')
    useSettingsStore.setState({ currentProject: '/tmp/project' })

    const renderer = renderDom(<MemorySettingsPanel />)
    await flushAsync()
    const callCount = mockInvoke.mock.calls.length

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 80))
    })

    expect(mockInvoke.mock.calls.length).toBe(callCount)
    renderer.unmount()
  })
})
