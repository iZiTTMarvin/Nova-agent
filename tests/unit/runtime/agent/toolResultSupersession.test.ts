/**
 * toolResultSupersession 纯函数判定测试。
 *
 * 只验证 plan 的内容（哪些 toolCallId 被覆盖、为何），
 * 不涉及 artifact 写入与占位符——那是 projectRequestMessages 的职责。
 */
import { describe, it, expect } from 'vitest'
import { planToolResultSupersession } from '../../../../src/runtime/agent/core/toolResultSupersession'
import type { ChatMessage } from '../../../../src/runtime/model/types'

function asst(id: string, name: string, args: string): ChatMessage {
  return { role: 'assistant', content: '', toolCalls: [{ id, name, arguments: args }] }
}

function tool(id: string, content: string): ChatMessage {
  return { role: 'tool', content, toolCallId: id }
}

function readArgs(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ file_path: 'a', ...overrides })
}

function bashArgs(command: string): string {
  return JSON.stringify({ command })
}

describe('planToolResultSupersession', () => {
  it('exact_duplicate：两次相同 read(file_path=a)，第一次被标记', () => {
    const messages: ChatMessage[] = [
      asst('r1', 'read', readArgs()),
      tool('r1', 'first output'),
      asst('r2', 'read', readArgs()),
      tool('r2', 'second output')
    ]
    const plan = planToolResultSupersession(messages)
    expect(plan.get('r1')).toBe('exact_duplicate')
    expect(plan.has('r2')).toBe(false)
  })

  it('exact_duplicate：参数顺序不同但等价仍视为重复', () => {
    const messages: ChatMessage[] = [
      asst('r1', 'read', JSON.stringify({ file_path: 'a', offset: 0 })),
      tool('r1', 'out1'),
      asst('r2', 'read', JSON.stringify({ offset: 0, file_path: 'a' })),
      tool('r2', 'out2')
    ]
    const plan = planToolResultSupersession(messages)
    expect(plan.get('r1')).toBe('exact_duplicate')
  })

  it('read_range_covered：limit=50 在前、limit=100 在后，前者被标记', () => {
    const messages: ChatMessage[] = [
      asst('r1', 'read', readArgs({ offset: 0, limit: 50 })),
      tool('r1', 'partial'),
      asst('r2', 'read', readArgs({ offset: 0, limit: 100 })),
      tool('r2', 'fuller')
    ]
    const plan = planToolResultSupersession(messages)
    expect(plan.get('r1')).toBe('read_range_covered')
    expect(plan.has('r2')).toBe(false)
  })

  it('read_range_covered：limit=100 在前、limit=50 在后，都不标记（新范围更小不覆盖）', () => {
    const messages: ChatMessage[] = [
      asst('r1', 'read', readArgs({ offset: 0, limit: 100 })),
      tool('r1', 'fuller'),
      asst('r2', 'read', readArgs({ offset: 0, limit: 50 })),
      tool('r2', 'partial')
    ]
    const plan = planToolResultSupersession(messages)
    expect(plan.size).toBe(0)
  })

  it('read_range_covered：省略 limit（读到末尾）的较晚 read 覆盖较早的有限 read', () => {
    const messages: ChatMessage[] = [
      asst('r1', 'read', readArgs({ offset: 5, limit: 50 })),
      tool('r1', 'partial from 5'),
      asst('r2', 'read', readArgs({ offset: 0 })),
      tool('r2', 'full from 0 to end')
    ]
    const plan = planToolResultSupersession(messages)
    expect(plan.get('r1')).toBe('read_range_covered')
    expect(plan.has('r2')).toBe(false)
  })

  it('read_range_covered：读到末尾的较晚 read 不能覆盖起始更早的有限 read（范围未完全包含）', () => {
    // r1 从 0 起 50 行；r2 从 10 起读到末尾——不含 0~9 行，不覆盖
    const messages: ChatMessage[] = [
      asst('r1', 'read', readArgs({ offset: 0, limit: 50 })),
      tool('r1', '0..49'),
      asst('r2', 'read', readArgs({ offset: 10 })),
      tool('r2', '10..end')
    ]
    const plan = planToolResultSupersession(messages)
    expect(plan.size).toBe(0)
  })

  it('read_range_covered：不同 file_path 不互相覆盖', () => {
    const messages: ChatMessage[] = [
      asst('r1', 'read', JSON.stringify({ file_path: 'a', offset: 0, limit: 50 })),
      tool('r1', 'a'),
      asst('r2', 'read', JSON.stringify({ file_path: 'b', offset: 0, limit: 100 })),
      tool('r2', 'b')
    ]
    const plan = planToolResultSupersession(messages)
    expect(plan.size).toBe(0)
  })

  it('exact_duplicate 优先：两次完全相同的 git status，第一次标记为 exact_duplicate', () => {
    const messages: ChatMessage[] = [
      asst('b1', 'bash', bashArgs('git status')),
      tool('b1', 'status 1'),
      asst('b2', 'bash', bashArgs('git status')),
      tool('b2', 'status 2')
    ]
    const plan = planToolResultSupersession(messages)
    expect(plan.get('b1')).toBe('exact_duplicate')
    expect(plan.has('b2')).toBe(false)
  })

  it('idempotent_snapshot：等效命令（仅空格差异）的新快照覆盖旧快照', () => {
    // args JSON 因空格不同而不被 exact_duplicate 命中，交由 idempotent_snapshot 按规范化命令分组
    const messages: ChatMessage[] = [
      asst('b1', 'bash', bashArgs('git status -s')),
      tool('b1', 'status short 1'),
      asst('b2', 'bash', bashArgs('git status  -s')),
      tool('b2', 'status short 2')
    ]
    const plan = planToolResultSupersession(messages)
    expect(plan.get('b1')).toBe('idempotent_snapshot')
    expect(plan.has('b2')).toBe(false)
  })

  it('idempotent_snapshot：git status 与 git log 互不覆盖（不同规范化命令）', () => {
    const messages: ChatMessage[] = [
      asst('b1', 'bash', bashArgs('git status')),
      tool('b1', 'status'),
      asst('b2', 'bash', bashArgs('git log')),
      tool('b2', 'log')
    ]
    const plan = planToolResultSupersession(messages)
    expect(plan.size).toBe(0)
  })

  it('idempotent_snapshot：npm test 不参与（白名单外且含排除词）', () => {
    // 仅空格差异避免 exact_duplicate 命中，纯粹检验白名单/排除词
    const messages: ChatMessage[] = [
      asst('b1', 'bash', bashArgs('npm test')),
      tool('b1', 'tests 1'),
      asst('b2', 'bash', bashArgs('npm  test')),
      tool('b2', 'tests 2')
    ]
    const plan = planToolResultSupersession(messages)
    expect(plan.size).toBe(0)
  })

  it('idempotent_snapshot：复合命令 git status && git diff 不参与', () => {
    const messages: ChatMessage[] = [
      asst('b1', 'bash', bashArgs('git status && git diff')),
      tool('b1', 'combined'),
      asst('b2', 'bash', bashArgs('git status && git diff')),
      tool('b2', 'combined again')
    ]
    const plan = planToolResultSupersession(messages)
    // 复合命令不进入 idempotent；但 args 完全一致会被 exact_duplicate 命中
    expect(plan.get('b1')).toBe('exact_duplicate')
  })

  it('复合命令即便等效也不走 idempotent_snapshot（仅 exact_duplicate）', () => {
    const messages: ChatMessage[] = [
      asst('b1', 'bash', bashArgs('git status; echo done')),
      tool('b1', 'a'),
      asst('b2', 'bash', bashArgs('git status ; echo done')),
      tool('b2', 'b')
    ]
    const plan = planToolResultSupersession(messages)
    expect(plan.size).toBe(0)
  })

  it('失败结果不作为覆盖者：失败的较晚 read 不覆盖成功的较早 read', () => {
    const messages: ChatMessage[] = [
      asst('r1', 'read', readArgs()),
      tool('r1', 'real content'),
      asst('r2', 'read', readArgs()),
      tool('r2', '工具执行失败: 读取失败')
    ]
    const plan = planToolResultSupersession(messages)
    expect(plan.size).toBe(0)
  })

  it('失败结果可被成功结果覆盖：失败的较早 read 被成功的较晚 read 覆盖', () => {
    const messages: ChatMessage[] = [
      asst('r1', 'read', readArgs()),
      tool('r1', '工具执行失败: 读取失败'),
      asst('r2', 'read', readArgs()),
      tool('r2', 'real content')
    ]
    const plan = planToolResultSupersession(messages)
    expect(plan.get('r1')).toBe('exact_duplicate')
  })

  it('参数解析失败（非法 JSON）不归档、不抛异常', () => {
    const messages: ChatMessage[] = [
      asst('r1', 'read', '{invalid json'),
      tool('r1', 'content'),
      asst('r2', 'read', readArgs({ offset: 0, limit: 100 })),
      tool('r2', 'content2')
    ]
    expect(() => planToolResultSupersession(messages)).not.toThrow()
    const plan = planToolResultSupersession(messages)
    expect(plan.size).toBe(0)
  })

  it('无配对 tool 结果的 assistant.toolCalls 不崩溃，孤儿 tool 结果不参与', () => {
    const messages: ChatMessage[] = [
      // 声明了调用但没有对应 tool 结果
      asst('orphan-call', 'read', readArgs()),
      // tool 结果但没有对应的 assistant 声明
      tool('orphan-result', 'no matching call')
    ]
    expect(() => planToolResultSupersession(messages)).not.toThrow()
    const plan = planToolResultSupersession(messages)
    expect(plan.size).toBe(0)
  })

  it('offset 为负数或非有限数的 read 不参与覆盖判定', () => {
    const messages: ChatMessage[] = [
      asst('r1', 'read', readArgs({ offset: -1, limit: 50 })),
      tool('r1', 'a'),
      asst('r2', 'read', readArgs({ offset: 0, limit: 100 })),
      tool('r2', 'b')
    ]
    const plan = planToolResultSupersession(messages)
    // r1 offset 非法 → 跳过；r1 与 r2 既不构成 exact_duplicate（args 不同）也不构成 read_range
    expect(plan.has('r1')).toBe(false)
    expect(plan.has('r2')).toBe(false)
  })
})
