// @vitest-environment jsdom

/**
 * 输入框运行态：编排运行期间回车不发送、不排队，只提示是否中断。
 *
 * 同时回归默认模式：没有编排 run 时回车照常发送 / 排队，行为不变。
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../../src/renderer/features/chat/ChatPanel'
import { useChatStore, resetChatStoreForTests } from '../../../src/renderer/stores/useChatStore'
import {
  useSettingsStore,
  resetSettingsStoreForTests
} from '../../../src/renderer/stores/useSettingsStore'
import { resetAgentStoreForTests } from '../../../src/renderer/stores/useAgentStore'
import { useRunStore } from '../../../src/renderer/stores/useRunStore'
import { useWorkflowStore } from '../../../src/renderer/features/workflow/useWorkflowStore'
import { act, renderDom, type DomRenderResult } from './renderDom'

vi.mock('../../../src/renderer/features/chat/MessageItem', () => ({ MessageItem: () => null }))
vi.mock('../../../src/renderer/features/mode-switch/ModeSwitch', () => ({ ModeSwitch: () => null }))
vi.mock('../../../src/renderer/features/chat/ModelSelector', () => ({ ModelSelector: () => null }))
vi.mock('../../../src/renderer/features/chat/ContextIndicator', () => ({ ContextIndicator: () => null }))
vi.mock('../../../src/renderer/components/ImagePreviewBar', () => ({ ImagePreviewBar: () => null }))
vi.mock('../../../src/renderer/features/todo/TodoPanel', () => ({ TodoPanel: () => null }))
vi.mock('../../../src/renderer/features/ask/AskQuestionPanel', () => ({ AskQuestionPanel: () => null }))
vi.mock('../../../src/renderer/features/chat/RecoveryBanner', () => ({ RecoveryBanner: () => null }))
vi.mock('../../../src/renderer/features/subagents/SubagentSessionHeader', () => ({
  SubagentSessionHeader: () => null
}))
vi.mock('../../../src/renderer/components/ImagePreviewDialog', () => ({ ImagePreviewDialog: () => null }))
vi.mock('../../../src/renderer/features/skills/SkillAC', () => ({
  SkillAC: React.forwardRef(() => null)
}))
vi.mock('../../../src/renderer/components/Icons', () => ({
  SendIcon: () => null,
  StopIcon: () => null,
  NovaLogo: () => null,
  ImageIcon: () => null
}))
vi.mock('framer-motion', () => import('./_framerMotionMock'))

const mockInvoke = vi.fn()

function mountChatPanel(): DomRenderResult {
  return renderDom(React.createElement(ChatPanel))
}

async function typeAndPressEnter(
  renderer: DomRenderResult,
  text: string
): Promise<void> {
  const textarea = renderer.container.querySelector<HTMLTextAreaElement>('textarea')
  if (!textarea) throw new Error('textarea not found')
  act(() => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    valueSetter?.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  // handleSend 内部有 await（preSendGate）：必须把微任务排空后再断言
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: false,
      bubbles: true,
      cancelable: true
    }))
    await Promise.resolve()
  })
}

describe('ChatPanel 编排运行态输入互斥', () => {
  let sendMessage: ReturnType<typeof vi.fn>
  let enqueuePendingMessage: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    resetChatStoreForTests()
    resetSettingsStoreForTests()
    resetAgentStoreForTests()
    useRunStore.getState().resetForTests()
    useWorkflowStore.getState().clear()

    sendMessage = vi.fn(async () => true)
    enqueuePendingMessage = vi.fn()

    mockInvoke.mockResolvedValue(undefined)
    Object.assign(window, {
      api: { invoke: mockInvoke, on: vi.fn(() => () => {}), removeAllListeners: vi.fn() },
      nova: { skill: { onChange: vi.fn(() => () => {}), list: vi.fn(() => []), reload: vi.fn() } }
    })

    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    useChatStore.setState({
      currentSessionId: 'sess_1',
      messages: [],
      isGenerating: false,
      sendMessage,
      enqueuePendingMessage
    } as never)
    useSettingsStore.setState({
      currentProject: 'D:/tmp/project',
      modelConfig: { modelId: 'm', baseUrl: 'http://x', apiKey: 'k' }
    } as never)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('Child Session interrupted 视图不暴露普通会话的继续与回滚动作', () => {
    useChatStore.setState({
      currentSessionId: 'child-session',
      currentSubagentTask: 'inspect',
      sessions: [{
        id: 'child-session',
        workspaceRoot: 'D:/tmp/project',
        mode: 'plan',
        createdAt: 1,
        updatedAt: 1,
        messageCount: 0,
        kind: 'subagent',
        subagent: {
          lineage: { parentSessionId: 'parent-session', depth: 1 },
          profile: {
            profileId: 'explore',
            name: 'explore',
            permissionCeiling: 'read_only'
          }
        }
      }]
    } as never)
    useRunStore.setState({ interruptedRunId: 'run-child', interruptedSteps: [] })

    const renderer = mountChatPanel()
    const text = Array.from(renderer.container.querySelectorAll('button'))
      .map(button => button.textContent ?? '')

    expect(text).not.toContain('继续分析')
    expect(text).not.toContain('回滚本轮')
    expect(renderer.container.querySelectorAll('textarea')).toHaveLength(0)
    renderer.unmount()
  })

  it('编排运行中：回车既不发送也不排队，只弹中断提示', async () => {
    act(() => {
      useWorkflowStore.getState().applyRunState({
        runId: 'run-1',
        sessionId: 'sess_1',
        workflow: 'compose',
        status: 'running',
        phase: 'implement'
      })
    })

    const renderer = mountChatPanel()
    await typeAndPressEnter(renderer, '再改一下登录页')

    expect(sendMessage).not.toHaveBeenCalled()
    expect(enqueuePendingMessage).not.toHaveBeenCalled()
    expect(useWorkflowStore.getState().busyNotice).toEqual({
      runId: 'run-1',
      workflow: 'compose',
      phase: 'implement'
    })
    // 输入内容保留，用户可以在中断后直接再发
    expect(renderer.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('再改一下登录页')

    renderer.unmount()
  })

  it('编排属于其它会话时不拦截本会话发送', async () => {
    act(() => {
      useWorkflowStore.getState().applyRunState({
        runId: 'run-1',
        sessionId: 'sess_other',
        workflow: 'compose',
        status: 'running',
        phase: 'implement'
      })
    })

    const renderer = mountChatPanel()
    await typeAndPressEnter(renderer, '你好')

    expect(sendMessage).toHaveBeenCalledWith('你好', [])
    expect(useWorkflowStore.getState().busyNotice).toBeNull()

    renderer.unmount()
  })

  it('默认模式回归：无编排 run 时回车照常发送', async () => {
    const renderer = mountChatPanel()
    await typeAndPressEnter(renderer, '写个测试')

    expect(sendMessage).toHaveBeenCalledWith('写个测试', [])
    expect(useWorkflowStore.getState().busyNotice).toBeNull()

    renderer.unmount()
  })

  it('compose 模式 Auto 默认关闭，打开后随 send-message 传递快照', async () => {
    useSettingsStore.setState({ currentMode: 'compose' } as never)
    const renderer = mountChatPanel()
    const toggle = renderer.container.querySelector<HTMLButtonElement>('[aria-pressed]')
    expect(toggle).not.toBeNull()

    expect(toggle?.getAttribute('aria-pressed')).toBe('false')
    expect(toggle?.getAttribute('aria-label')).toBe('全自动完成')
    await act(async () => {
      toggle?.click()
      await Promise.resolve()
    })
    expect(renderer.container.querySelector<HTMLButtonElement>('[aria-pressed]')?.getAttribute('aria-pressed')).toBe('true')

    await typeAndPressEnter(renderer, '完成整套登录功能')

    expect(sendMessage).toHaveBeenCalledWith('完成整套登录功能', [], { autoMode: true })
    renderer.unmount()
  })

  it('默认模式回归：Agent 运行中的入口行为不变（既不发送也不弹编排提示）', async () => {
    act(() => {
      useChatStore.setState({ isGenerating: true } as never)
    })

    const renderer = mountChatPanel()
    await typeAndPressEnter(renderer, '顺手改下这里')

    // 运行中由 isGenerating 分支拦下，与本次改动前一致；不得走编排运行态提示
    expect(sendMessage).not.toHaveBeenCalled()
    expect(useWorkflowStore.getState().busyNotice).toBeNull()

    renderer.unmount()
  })

  it('编排运行时输入框占位提示中断语义', async () => {
    act(() => {
      useWorkflowStore.getState().applyRunState({
        runId: 'run-1',
        sessionId: 'sess_1',
        workflow: 'compose',
        status: 'running',
        phase: 'implement'
      })
    })

    const renderer = mountChatPanel()
    expect(renderer.container.querySelector<HTMLTextAreaElement>('textarea')?.placeholder).toContain('中断')

    renderer.unmount()
  })
})
