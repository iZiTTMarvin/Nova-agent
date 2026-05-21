/**
 * IPC 类型系统验证测试
 * 验证共享类型定义的正确性和完整性
 */
import { describe, it, expect } from 'vitest'
import type { IpcCommands, IpcCommandChannel, IpcEvents, IpcEventChannel } from '../../src/shared/ipc/types'
import {
  PING, SELECT_PROJECT, SEND_MESSAGE, CANCEL_EXECUTION,
  SAVE_MODEL_CONFIG, LOAD_MODEL_CONFIG, SET_MODE,
  ACCEPT_FILE, REJECT_FILE, ROLLBACK_MESSAGE,
  RESPOND_PERMISSION, LOAD_SESSIONS, LOAD_SESSION,
  AGENT_MESSAGE_START, AGENT_TEXT_DELTA, AGENT_TOOL_CALL,
  AGENT_TOOL_RESULT, AGENT_PERMISSION_REQUEST,
  AGENT_DIFF_UPDATE, AGENT_VERIFICATION_RESULT,
  AGENT_ERROR, AGENT_MESSAGE_END
} from '../../src/shared/ipc/channels'

describe('IPC channel 常量', () => {
  it('定义了 13 个命令 channel', () => {
    const commandChannels = [
      PING, SELECT_PROJECT, SEND_MESSAGE, CANCEL_EXECUTION,
      SAVE_MODEL_CONFIG, LOAD_MODEL_CONFIG, SET_MODE,
      ACCEPT_FILE, REJECT_FILE, ROLLBACK_MESSAGE,
      RESPOND_PERMISSION, LOAD_SESSIONS, LOAD_SESSION
    ]
    expect(commandChannels).toHaveLength(13)
    // 每个 channel 都是唯一的字符串
    expect(new Set(commandChannels).size).toBe(13)
  })

  it('定义了 9 个事件 channel', () => {
    const eventChannels = [
      AGENT_MESSAGE_START, AGENT_TEXT_DELTA, AGENT_TOOL_CALL,
      AGENT_TOOL_RESULT, AGENT_PERMISSION_REQUEST,
      AGENT_DIFF_UPDATE, AGENT_VERIFICATION_RESULT,
      AGENT_ERROR, AGENT_MESSAGE_END
    ]
    expect(eventChannels).toHaveLength(9)
    expect(new Set(eventChannels).size).toBe(9)
  })
})

describe('IpcCommands 类型完整性', () => {
  it('ping 命令返回 string 类型', () => {
    // 编译期类型检查：确认 ping 返回 string
    type PingResult = IpcCommands['ping']['result']
    const _assertString: PingResult = 'test-value'
    expect(typeof _assertString).toBe('string')
  })

  it('select-project 命令返回 string | null 类型', () => {
    type Result = IpcCommands['select-project']['result']
    const _assertNull: Result = null
    const _assertString: Result = '/some/path'
    expect(_assertNull).toBeNull()
    expect(typeof _assertString).toBe('string')
  })

  it('send-message 命令参数包含 sessionId 和 content', () => {
    type Params = IpcCommands['send-message']['params']
    const params: Params = { sessionId: 's1', content: 'hello' }
    expect(params.sessionId).toBe('s1')
    expect(params.content).toBe('hello')
  })
})

describe('IpcEvents 类型完整性', () => {
  it('agent:text-delta 事件包含 messageId 和 delta', () => {
    type Event = IpcEvents['agent:text-delta']
    const data: Event = { messageId: 'm1', delta: 'hello' }
    expect(data.messageId).toBe('m1')
    expect(data.delta).toBe('hello')
  })

  it('agent:permission-request 事件包含 risk 字段', () => {
    type Event = IpcEvents['agent:permission-request']
    const data: Event = {
      requestId: 'r1',
      toolName: 'bash',
      args: { command: 'rm -rf /' },
      risk: 'high'
    }
    expect(data.risk).toBe('high')
  })
})
