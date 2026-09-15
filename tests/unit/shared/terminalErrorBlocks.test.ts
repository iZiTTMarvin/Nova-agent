/**
 * 终态错误并入 blocks：主进程 / 渲染层共用逻辑
 */
import { describe, it, expect } from 'vitest'
import {
  TERMINAL_ERROR_NOTICE_PREFIX,
  CONTEXT_BUDGET_EXCEEDED_NOTICE,
  formatTerminalErrorNotice,
  formatTerminalErrorMessage,
  appendTerminalErrorToBlocks,
  resolveTerminalErrorActions
} from '../../../src/shared/session/terminalErrorBlocks'
import {
  encodeModelFailureError,
  parseModelFailureError,
  MODEL_FAILURE_KINDS
} from '../../../src/shared/model/failureKinds'
import type { MessageBlock } from '../../../src/shared/session/types'

describe('appendTerminalErrorToBlocks', () => {
  it('摘要校验失败明确保留历史，不误导用户删除消息', () => {
    expect(formatTerminalErrorMessage('ContextRecoveryFailed: invalid-summary'))
      .toBe('模型返回的历史摘要未通过完整性校验，本轮已停止。原始记录已保留，可重试继续任务。')
  })
  it('执行权被接管不提示重试，也不暴露内部标识', () => {
    expect(formatTerminalErrorMessage('ContextRecoveryFailed: authority-expired'))
      .toBe('本轮执行已被新的请求接管，历史保持不变。')
  })
  it('只转换预算终态错误，其他错误原文保持不变', () => {
    expect(formatTerminalErrorMessage(
      'ContextBudgetExceeded: estimatedTokens=120 serializedBytes=480 attemptedCompaction=true'
    )).toBe(CONTEXT_BUDGET_EXCEEDED_NOTICE)
    expect(formatTerminalErrorMessage('API 超时')).toBe('API 超时')
    expect(formatTerminalErrorMessage('读取 ContextBudgetExceeded.ts 失败'))
      .toBe('读取 ContextBudgetExceeded.ts 失败')
    expect(formatTerminalErrorNotice('API 超时')).toBe(`${TERMINAL_ERROR_NOTICE_PREFIX}API 超时`)
  })

  it('前缀常量与 format 一致', () => {
    expect(formatTerminalErrorNotice('预算用尽')).toBe(`${TERMINAL_ERROR_NOTICE_PREFIX}预算用尽`)
  })

  it('末尾 text 拼接提示；running tool 标为 error', () => {
    const blocks: MessageBlock[] = [
      {
        type: 'tool',
        toolCallId: 'tc1',
        toolName: 'ls',
        arguments: {},
        status: 'running'
      },
      { type: 'text', content: '已成功的回复' }
    ]
    const out = appendTerminalErrorToBlocks(blocks, 'API 超时')
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ type: 'tool', status: 'error', result: 'API 超时' })
    expect(out[1]).toMatchObject({
      type: 'text',
      content: expect.stringContaining('已成功的回复')
    })
    expect((out[1] as { content: string }).content).toContain('API 超时')
    expect((out[1] as { content: string }).content).toContain(TERMINAL_ERROR_NOTICE_PREFIX)
  })

  it('末尾非 text 时新增 text 错误块', () => {
    const blocks: MessageBlock[] = [
      {
        type: 'tool',
        toolCallId: 'tc1',
        toolName: 'ls',
        arguments: {},
        status: 'success',
        result: 'ok'
      }
    ]
    const out = appendTerminalErrorToBlocks(blocks, '熔断')
    expect(out).toHaveLength(2)
    expect(out[1]).toEqual({
      type: 'text',
      content: formatTerminalErrorNotice('熔断')
    })
  })
})

describe('ModelFailure 前缀协议', () => {
  it('编解码往返一致，非法 kind 拒识', () => {
    const encoded = encodeModelFailureError('auth', '401 Unauthorized')
    expect(encoded).toBe('ModelFailure:auth:401 Unauthorized')
    expect(parseModelFailureError(encoded)).toEqual({ kind: 'auth', message: '401 Unauthorized' })
    expect(parseModelFailureError('ModelFailure:not-a-kind:x')).toBeNull()
    expect(parseModelFailureError('普通错误文本')).toBeNull()
    expect(parseModelFailureError('ModelFailure:')).toBeNull()
  })

  it('8 类失败各出人话文案，无一是英文原文直出', () => {
    for (const kind of MODEL_FAILURE_KINDS) {
      const translated = formatTerminalErrorMessage(encodeModelFailureError(kind, 'raw provider text'))
      expect(translated.length).toBeGreaterThan(4)
      expect(translated).not.toContain('ModelFailure:')
      expect(translated).not.toBe('raw provider text')
    }
  })

  it('每类失败带可执行动作，不同类别动作符合恢复语义', () => {
    expect(resolveTerminalErrorActions(encodeModelFailureError('auth', 'x'))).toEqual(['open-settings'])
    expect(resolveTerminalErrorActions(encodeModelFailureError('provider_billing', 'x'))).toEqual(['open-settings'])
    expect(resolveTerminalErrorActions(encodeModelFailureError('network', 'x'))).toEqual(['retry'])
    expect(resolveTerminalErrorActions(encodeModelFailureError('timeout', 'x'))).toEqual(['retry'])
    expect(resolveTerminalErrorActions(encodeModelFailureError('context_overflow', 'x'))).toEqual(['new-session'])
    expect(resolveTerminalErrorActions(encodeModelFailureError('provider_unavailable', 'x'))).toEqual(['switch-model'])
    expect(resolveTerminalErrorActions(encodeModelFailureError('unknown', 'x'))).toEqual(['export-diagnostics'])
    expect(resolveTerminalErrorActions(encodeModelFailureError('rate_limit', 'x'))).toEqual(['retry', 'switch-model'])
  })

  it('unknown 包裹 ContextBudgetExceeded 时，文案与动作都回退到内层语义', () => {
    const error = 'ModelFailure:unknown:ContextBudgetExceeded: estimatedTokens=120'
    expect(formatTerminalErrorMessage(error)).toBe(CONTEXT_BUDGET_EXCEEDED_NOTICE)
    expect(resolveTerminalErrorActions(error)).toEqual(['new-session'])
    // 旧家族裸文本同样有动作（无 ModelFailure 前缀的历史形态）
    expect(resolveTerminalErrorActions('ContextBudgetExceeded: estimatedTokens=1')).toEqual(['new-session'])
  })

  it('无分类前缀的错误没有动作按钮，文案原样保留（旧会话兼容）', () => {
    expect(resolveTerminalErrorActions('API 超时')).toEqual([])
    expect(formatTerminalErrorMessage('API 超时')).toBe('API 超时')
    // 旧前缀家族仍按原有翻译，不被新协议破坏
    expect(formatTerminalErrorMessage('ContextRecoveryFailed: authority-expired'))
      .toBe('本轮执行已被新的请求接管，历史保持不变。')
  })

  it('带前缀错误进 blocks 时用户看到的是人话，不是协议前缀', () => {
    const blocks: MessageBlock[] = [
      { type: 'tool', toolCallId: 'tc1', toolName: 'web_search', arguments: {}, status: 'running' }
    ]
    const out = appendTerminalErrorToBlocks(blocks, encodeModelFailureError('auth', '401'))
    expect(out[0]).toMatchObject({ type: 'tool', status: 'error' })
    expect((out[0] as { result?: string }).result).not.toContain('ModelFailure:')
    const textBlock = out[out.length - 1] as { type: string; content: string }
    expect(textBlock.type).toBe('text')
    expect(textBlock.content).not.toContain('ModelFailure:')
    expect(textBlock.content).toContain('API Key')
  })
})
