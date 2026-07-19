import { describe, it, expect, vi } from 'vitest'
import type { AgentEvent } from '../../../src/runtime/agent/types'

// 避免 agentHandler → sessionHandler → main/index 的副作用链（app.whenReady）
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

import { forwardEventToRenderer } from '../../../src/main/agent/events'

/** 构造可 spy 的 BrowserWindow mock */
function makeMainWindow() {
  const send = vi.fn()
  return {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send
    },
    _send: send
  }
}

describe('forwardEventToRenderer（recovery / hook IPC）', () => {
  it('hook_error → agent:hook-error', () => {
    const win = makeMainWindow()
    const event: AgentEvent = {
      type: 'hook_error',
      messageId: 'msg_1',
      hookEvent: 'preToolUse',
      error: 'handler threw'
    }

    forwardEventToRenderer(win as never, event)

    expect(win._send).toHaveBeenCalledWith('agent:hook-error', {
      messageId: 'msg_1',
      hookEvent: 'preToolUse',
      error: 'handler threw'
    })
  })

  it('recovery_hint → agent:recovery-hint', () => {
    const win = makeMainWindow()
    const event: AgentEvent = {
      type: 'recovery_hint',
      messageId: 'msg_2',
      hint: '[系统恢复提示] 正在重试',
      attempt: 2
    }

    forwardEventToRenderer(win as never, event)

    expect(win._send).toHaveBeenCalledWith('agent:recovery-hint', {
      messageId: 'msg_2',
      hint: '[系统恢复提示] 正在重试',
      attempt: 2
    })
  })

  it('recovery_state → agent:recovery-state（retrying 原样转发 UI 字段）', () => {
    const win = makeMainWindow()
    const event: AgentEvent = {
      type: 'recovery_state',
      messageId: 'msg_3',
      state: {
        kind: 'retrying',
        attempt: 1,
        lastError: 'rate limit',
        maxAttempts: 3
      }
    }

    forwardEventToRenderer(win as never, event)

    expect(win._send).toHaveBeenCalledWith('agent:recovery-state', {
      messageId: 'msg_3',
      state: event.state
    })
  })

  it('recovery_state recovering 应截断 snapshot，不传 ChatMessage[]', () => {
    const win = makeMainWindow()
    const bigSnapshot = [{ role: 'user' as const, content: 'x'.repeat(10_000) }]

    forwardEventToRenderer(win as never, {
      type: 'recovery_state',
      messageId: 'msg_4',
      state: {
        kind: 'recovering',
        fromMessageId: 'msg_old',
        snapshot: bigSnapshot
      }
    })

    expect(win._send).toHaveBeenCalledWith('agent:recovery-state', {
      messageId: 'msg_4',
      state: { kind: 'recovering', fromMessageId: 'msg_old' }
    })
    const payload = win._send.mock.calls[0][1] as { state: Record<string, unknown> }
    expect(payload.state).not.toHaveProperty('snapshot')
  })

  it('窗口已销毁时不发送 IPC', () => {
    const win = {
      isDestroyed: () => true,
      webContents: { send: vi.fn(), isDestroyed: () => false }
    }

    forwardEventToRenderer(win as never, {
      type: 'hook_error',
      messageId: 'msg_x',
      hookEvent: 'onError',
      error: 'boom'
    })

    expect(win.webContents.send).not.toHaveBeenCalled()
  })
})
