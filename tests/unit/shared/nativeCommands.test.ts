import { describe, expect, it } from 'vitest'
import {
  parseNativeCommand,
  validateNativeCommand
} from '../../../src/shared/commands'

describe('native slash commands', () => {
  it('只识别内置命令并保留 init 的补充要求', () => {
    expect(parseNativeCommand('/init  保留现有测试说明  ')).toEqual({
      command: expect.objectContaining({ name: 'init', execution: 'agent' }),
      args: '保留现有测试说明'
    })
    expect(parseNativeCommand('/unknown')).toBeNull()
    expect(parseNativeCommand('/workspace/path')).toBeNull()
  })

  it('无参数命令收到参数时在发送前拒绝', () => {
    const invocation = parseNativeCommand('/compact 只保留代码')
    expect(invocation).not.toBeNull()
    expect(validateNativeCommand(invocation!, { mode: 'default' })).toEqual(
      expect.objectContaining({ reason: 'invalid_arguments', commandName: 'compact' })
    )
  })

  it('只读规划模式不允许 init 写工作区规则', () => {
    const invocation = parseNativeCommand('/init')
    expect(invocation).not.toBeNull()
    expect(validateNativeCommand(invocation!, { mode: 'plan' })).toEqual(
      expect.objectContaining({ reason: 'mode_not_allowed', commandName: 'init' })
    )
    expect(validateNativeCommand(invocation!, { mode: 'default' })).toBeNull()
  })

  it('命令结果不支持重新生成，命令输入不接受图片', () => {
    const invocation = parseNativeCommand('/plan')
    expect(invocation).not.toBeNull()
    expect(validateNativeCommand(invocation!, { mode: 'default', regenerate: true })).toEqual(
      expect.objectContaining({ reason: 'unsupported_action' })
    )
    expect(validateNativeCommand(invocation!, { mode: 'default', hasImages: true })).toEqual(
      expect.objectContaining({ reason: 'invalid_arguments' })
    )
  })
})
