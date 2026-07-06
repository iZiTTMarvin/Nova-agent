/**
 * ObservationCapture 单测
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import {
  ObservationCapture,
  buildObservationTitle,
  buildFilteredObservationTitle,
  extractObservationFacts,
  resetObservationCapturesForTests
} from '../../../../src/runtime/memory/ObservationCapture'
import { subscribeObservationCapture } from '../../../../src/runtime/memory/MemoryObservationBridge'
import { PRIVACY_REDACTED } from '../../../../src/runtime/memory/PrivacyFilter'
import { DEFAULT_NOVA_SETTINGS } from '../../../../src/runtime/settings/novaSettings'

const FAKE_SK = 'sk-fakefortestonly000000000002'
const FAKE_BEARER_CMD =
  'curl -H "Authorization: Bearer sk-fakefortestonly000000000003" https://api.example.com'

describe('ObservationCapture 纯逻辑', () => {
  let capture: ObservationCapture
  let now: number

  beforeEach(() => {
    resetObservationCapturesForTests()
    now = 1_000_000
    capture = new ObservationCapture({ now: () => now })
  })

  it('buildObservationTitle 含路径', () => {
    expect(buildObservationTitle('edit', { path: 'src/foo.ts' })).toBe('edit src/foo.ts')
  })

  it('buildFilteredObservationTitle 一次返回 title 与 hadSensitive', () => {
    const FAKE_BEARER_CMD =
      'curl -H "Authorization: Bearer sk-fakefortestonly000000000003" https://api.example.com'
    const { title, hadSensitive } = buildFilteredObservationTitle('bash', {
      command: FAKE_BEARER_CMD
    })
    expect(title).toContain(PRIVACY_REDACTED)
    expect(title).not.toContain('sk-fakefortestonly000000000003')
    expect(hadSensitive).toBe(true)
  })

  it('extractObservationFacts 取前三行非空', () => {
    expect(extractObservationFacts('a\n\nb\nc\nd')).toEqual(['a', 'b', 'c'])
  })

  it('tool_call + tool_result 写入 working buffer', () => {
    capture.onToolCall({
      sessionId: 's1',
      messageId: 'm1',
      toolCallId: 'tc1',
      toolName: 'edit',
      args: { path: 'src/a.ts', old_string: 'x', new_string: 'y' }
    })
    capture.onToolResult({
      sessionId: 's1',
      messageId: 'm1',
      toolCallId: 'tc1',
      toolName: 'edit',
      result: 'ok\nline2\nline3'
    })

    const buf = capture.getWorkingBuffer('s1')
    expect(buf).toHaveLength(1)
    expect(buf[0].title).toBe('edit src/a.ts')
    expect(buf[0].facts).toEqual(['ok', 'line2', 'line3'])
    expect(buf[0].filesTouched).toEqual(['src/a.ts'])
  })

  it('5 分钟内同 fingerprint 去重', () => {
    const call = {
      sessionId: 's1',
      messageId: 'm1',
      toolCallId: 'tc1',
      toolName: 'read',
      args: { path: 'README.md' }
    }
    capture.onToolCall(call)
    capture.onToolResult({
      ...call,
      result: 'same content'
    })
    capture.onToolCall({ ...call, toolCallId: 'tc2' })
    capture.onToolResult({
      ...call,
      toolCallId: 'tc2',
      result: 'same content'
    })
    expect(capture.getWorkingBuffer('s1')).toHaveLength(1)

    now += 5 * 60 * 1000 + 1
    capture.onToolCall({ ...call, toolCallId: 'tc3' })
    capture.onToolResult({
      ...call,
      toolCallId: 'tc3',
      result: 'same content'
    })
    expect(capture.getWorkingBuffer('s1')).toHaveLength(2)
  })

  it('输出含密钥时剥离且不含原始密钥', () => {
    capture.onToolCall({
      sessionId: 's1',
      messageId: 'm1',
      toolCallId: 'tc1',
      toolName: 'bash',
      args: { command: 'echo hi' }
    })
    capture.onToolResult({
      sessionId: 's1',
      messageId: 'm1',
      toolCallId: 'tc1',
      toolName: 'bash',
      result: `output\n${FAKE_SK}`
    })
    const buf = capture.getWorkingBuffer('s1')
    expect(buf).toHaveLength(1)
    expect(buf[0].facts.join('\n')).not.toContain(FAKE_SK)
    expect(buf[0].facts.join('\n')).toContain(PRIVACY_REDACTED)
    expect(buf[0].hadSensitive).toBe(true)
  })

  it('bash command 含 Bearer/sk- 时 title 经隐私过滤，不含原始密钥', () => {
    capture.onToolCall({
      sessionId: 's1',
      messageId: 'm1',
      toolCallId: 'tc-bash',
      toolName: 'bash',
      args: { command: FAKE_BEARER_CMD }
    })
    capture.onToolResult({
      sessionId: 's1',
      messageId: 'm1',
      toolCallId: 'tc-bash',
      toolName: 'bash',
      result: 'ok'
    })
    const buf = capture.getWorkingBuffer('s1')
    expect(buf).toHaveLength(1)
    expect(buf[0].title).not.toContain('sk-fakefortestonly000000000003')
    expect(buf[0].title).not.toContain('Bearer sk-fake')
    expect(buf[0].title).toContain(PRIVACY_REDACTED)
    expect(buf[0].hadSensitive).toBe(true)
  })

  it('密钥跨 77 字符边界时 title 先过滤再截断，不泄漏残片', () => {
    const prefix = 'a'.repeat(60)
    const secretCmd = `${prefix} run sk-fakefortestonly000000000099 extra`
    capture.onToolCall({
      sessionId: 's1',
      messageId: 'm1',
      toolCallId: 'tc-long',
      toolName: 'bash',
      args: { command: secretCmd }
    })
    capture.onToolResult({
      sessionId: 's1',
      messageId: 'm1',
      toolCallId: 'tc-long',
      toolName: 'bash',
      result: 'done'
    })
    const buf = capture.getWorkingBuffer('s1')
    expect(buf).toHaveLength(1)
    expect(buf[0].title).not.toContain('sk-fakefortestonly000000000099')
    expect(buf[0].title).not.toContain('sk-fake')
    expect(buf[0].title).toMatch(/\[REDACTED/)
    expect(buf[0].title.length).toBeLessThanOrEqual(80)
  })

  it('读取 .env 路径不采集', () => {
    capture.onToolCall({
      sessionId: 's1',
      messageId: 'm1',
      toolCallId: 'tc1',
      toolName: 'read',
      args: { path: '.env' }
    })
    capture.onToolResult({
      sessionId: 's1',
      messageId: 'm1',
      toolCallId: 'tc1',
      toolName: 'read',
      result: 'SECRET=shouldnotappear'
    })
    expect(capture.getWorkingBuffer('s1')).toHaveLength(0)
  })

  it('message_end 清理未配对 pending', () => {
    capture.onToolCall({
      sessionId: 's1',
      messageId: 'm1',
      toolCallId: 'orphan',
      toolName: 'read',
      args: { path: 'a.ts' }
    })
    capture.onMessageEnd('s1')
    capture.onToolResult({
      sessionId: 's1',
      messageId: 'm1',
      toolCallId: 'orphan',
      toolName: 'read',
      result: 'late'
    })
    expect(capture.getWorkingBuffer('s1')).toHaveLength(0)
  })

  it('buffer 超限无 overflow 回调时丢弃最旧', () => {
    const small = new ObservationCapture({ now: () => now, maxBufferSize: 2 })
    const base = {
      sessionId: 's1',
      messageId: 'm1',
      toolName: 'read',
      args: { path: 'a.ts' }
    }
    for (let i = 0; i < 3; i++) {
      small.onToolCall({ ...base, toolCallId: `tc${i}` })
      small.onToolResult({ ...base, toolCallId: `tc${i}`, result: `r${i}` })
    }
    const buf = small.getWorkingBuffer('s1')
    expect(buf).toHaveLength(2)
    expect(buf[0].facts[0]).toBe('r1')
  })

  it('buffer 超限时触发 onBufferOverflow', () => {
    const overflow = vi.fn()
    const capped = new ObservationCapture({
      now: () => now,
      maxBufferSize: 1,
      onBufferOverflow: overflow
    })
    const base = {
      sessionId: 's1',
      messageId: 'm1',
      toolName: 'read',
      args: { path: 'a.ts' }
    }
    capped.onToolCall({ ...base, toolCallId: 'tc1' })
    capped.onToolResult({ ...base, toolCallId: 'tc1', result: 'r1' })
    capped.onToolCall({ ...base, toolCallId: 'tc2' })
    capped.onToolResult({ ...base, toolCallId: 'tc2', result: 'r2' })
    expect(overflow).toHaveBeenCalledWith('s1')
  })
})

describe('MemoryObservationBridge', () => {
  beforeEach(() => {
    resetObservationCapturesForTests()
  })

  it('EventBus 订阅后采集 tool 轨迹', () => {
    const bus = new EventBus()
    const capture = new ObservationCapture()
    subscribeObservationCapture(bus, 'sess-a', capture)

    bus.emit({
      type: 'tool_call',
      messageId: 'msg1',
      toolCallId: 'call1',
      toolName: 'write',
      args: { path: 'notes/x.md', content: 'hi' }
    })
    bus.emit({
      type: 'tool_result',
      messageId: 'msg1',
      toolCallId: 'call1',
      toolName: 'write',
      result: 'written'
    })

    expect(capture.getWorkingBuffer('sess-a')).toHaveLength(1)
  })
})

describe('采集门控（随 memoryEnabled 一键统控）', () => {
  it('memoryCaptureEnabled 默认 true（随总开关开启）', () => {
    // 用户视角下记忆只有 memoryEnabled 一个按钮；采集子开关默认 true。
    expect(DEFAULT_NOVA_SETTINGS.memoryCaptureEnabled).toBe(true)
  })

  it('未挂载订阅时 buffer 保持为空', () => {
    resetObservationCapturesForTests()
    const capture = new ObservationCapture()
    expect(capture.getWorkingBuffer('any')).toEqual([])
  })
})
