/**
 * 编排事件的 main → renderer 转发。
 *
 * 进度块与 run 状态各走独立 channel：进度块在聊天流中产出消息块，
 * run 状态只驱动输入框运行态，两者使用独立 workflow:* 通道。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/main/services/SessionStoreHost', () => ({
  getSessionStore: () => ({
    appendMessage: vi.fn(),
    appendMessageFast: vi.fn(),
    save: vi.fn(),
    load: vi.fn(),
    getSessionsDir: () => '/tmp/test-sessions'
  })
}))

vi.mock('../../../src/main/index', () => ({
  setCurrentProjectPath: vi.fn(),
  setCurrentMode: vi.fn()
}))

import { emitWorkflowBusySignal, forwardEventToRenderer } from '../../../src/main/agent/events'
import type { AgentEvent } from '../../../src/runtime/agent/types'

function makeMainWindow() {
  const send = vi.fn()
  return {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send },
    _send: send
  }
}

describe('编排事件转发', () => {
  it('workflow_progress → workflow:progress（携带 status 与 detail）', () => {
    const win = makeMainWindow()
    const event: AgentEvent = {
      type: 'workflow_progress',
      runId: 'run-1',
      sessionId: 'sess-1',
      phase: 'implement',
      status: 'task_complete',
      detail: { taskId: 't-2', taskName: '加缓存' }
    }

    forwardEventToRenderer(win as never, event)

    expect(win._send).toHaveBeenCalledWith('workflow:progress', {
      runId: 'run-1',
      sessionId: 'sess-1',
      phase: 'implement',
      status: 'task_complete',
      detail: { taskId: 't-2', taskName: '加缓存' }
    })
  })

  it('无 detail 时不下发 detail 字段', () => {
    const win = makeMainWindow()
    forwardEventToRenderer(win as never, {
      type: 'workflow_progress',
      runId: 'run-1',
      phase: 'verify',
      status: 'started'
    })

    expect(win._send).toHaveBeenCalledWith('workflow:progress', {
      runId: 'run-1',
      sessionId: undefined,
      phase: 'verify',
      status: 'started'
    })
  })

  it('workflow_log → workflow:log（阶段活动与失败诊断行）', () => {
    const win = makeMainWindow()
    const event: AgentEvent = {
      type: 'workflow_log',
      runId: 'run-1',
      sessionId: 'sess-1',
      message: '[compose-brainstorm] 调用工具 read：src/a.ts'
    }

    forwardEventToRenderer(win as never, event)

    expect(win._send).toHaveBeenCalledWith('workflow:log', {
      runId: 'run-1',
      sessionId: 'sess-1',
      message: '[compose-brainstorm] 调用工具 read：src/a.ts'
    })
  })

  it('workflow_run_state → workflow:run-state', () => {
    const win = makeMainWindow()
    forwardEventToRenderer(win as never, {
      type: 'workflow_run_state',
      runId: 'run-1',
      sessionId: 'sess-1',
      workflow: 'compose',
      status: 'running',
      phase: 'brainstorm'
    })

    expect(win._send).toHaveBeenCalledWith('workflow:run-state', {
      runId: 'run-1',
      sessionId: 'sess-1',
      workflow: 'compose',
      status: 'running',
      phase: 'brainstorm'
    })
  })

  it('emitWorkflowBusySignal → workflow:busy', () => {
    const win = makeMainWindow()
    emitWorkflowBusySignal(win as never, {
      sessionId: 'sess-1',
      runId: 'run-1',
      workflow: 'compose',
      phase: 'implement'
    })

    expect(win._send).toHaveBeenCalledWith('workflow:busy', {
      sessionId: 'sess-1',
      runId: 'run-1',
      workflow: 'compose',
      phase: 'implement'
    })
  })

  it('窗口已销毁时不发送', () => {
    const send = vi.fn()
    const dead = { isDestroyed: () => true, webContents: { isDestroyed: () => true, send } }
    emitWorkflowBusySignal(dead as never, {
      sessionId: 's',
      runId: 'r',
      workflow: 'compose',
      phase: 'p'
    })
    expect(send).not.toHaveBeenCalled()
  })
})
