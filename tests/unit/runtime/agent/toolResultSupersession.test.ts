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

  it('bash 重复调用走 idempotent_snapshot：两次完全相同的 git status，第一次被标记', () => {
    const messages: ChatMessage[] = [
      asst('b1', 'bash', bashArgs('git status')),
      tool('b1', 'status 1'),
      asst('b2', 'bash', bashArgs('git status')),
      tool('b2', 'status 2')
    ]
    const plan = planToolResultSupersession(messages)
    expect(plan.get('b1')).toBe('idempotent_snapshot')
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

  it('idempotent_snapshot：npm test 不参与（git 白名单外）', () => {
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
    // bash 不参与 exact_duplicate，复合命令也不进 idempotent 白名单
    expect(plan.size).toBe(0)
  })

  it('复合命令即便等效也不走 idempotent_snapshot', () => {
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

  it('权限拒绝结果不作为覆盖者：较晚的权限拒绝不覆盖成功的较早 read', () => {
    const messages: ChatMessage[] = [
      asst('r1', 'read', readArgs()),
      tool('r1', 'real content'),
      asst('r2', 'read', readArgs()),
      tool('r2', '权限拒绝: 当前模式不允许读取该路径')
    ]
    const plan = planToolResultSupersession(messages)
    expect(plan.size).toBe(0)
  })

  it('权限拒绝的 bash 不作为覆盖者：成功的较早 git status 不被权限拒绝覆盖', () => {
    const messages: ChatMessage[] = [
      asst('b1', 'bash', bashArgs('git status')),
      tool('b1', 'status snapshot'),
      asst('b2', 'bash', bashArgs('git status')),
      tool('b2', '权限拒绝: plan 模式不允许执行命令')
    ]
    const plan = planToolResultSupersession(messages)
    expect(plan.size).toBe(0)
  })

  it('写工具不参与 exact_duplicate：两次相同 edit 均不归档', () => {
    const messages: ChatMessage[] = [
      asst('e1', 'edit', JSON.stringify({ path: 'a.ts', old: 'x', new: 'y' })),
      tool('e1', '已修改文件'),
      asst('e2', 'edit', JSON.stringify({ path: 'a.ts', old: 'x', new: 'y' })),
      tool('e2', '已修改文件')
    ]
    const plan = planToolResultSupersession(messages)
    expect(plan.size).toBe(0)
  })

  it('write 不参与 exact_duplicate：两次相同 write 均不归档', () => {
    const messages: ChatMessage[] = [
      asst('w1', 'write', JSON.stringify({ path: 'a.ts', content: 'hello' })),
      tool('w1', '已创建文件 "a.ts"'),
      asst('w2', 'write', JSON.stringify({ path: 'a.ts', content: 'hello' })),
      tool('w2', '已覆盖文件 "a.ts"')
    ]
    const plan = planToolResultSupersession(messages)
    expect(plan.size).toBe(0)
  })

  it('shell_session 不参与任何去重：两条同参 read 都保留（增量静默丢弃是真实回归）', () => {
    const args = JSON.stringify({ ref: 'psn_aaaaaaaaaaaa', action: 'read' })
    const messages: ChatMessage[] = [
      asst('s1', 'shell_session', args),
      tool('s1', 'output chunk 1'),
      asst('s2', 'shell_session', args),
      tool('s2', 'output chunk 2')
    ]
    const plan = planToolResultSupersession(messages)
    expect(plan.has('s1')).toBe(false)
    expect(plan.has('s2')).toBe(false)
  })

  it('limit=0 语义与 readTool 对齐：表示读到末尾', () => {
    // readTool 把 limit<1 归一为读到 EOF，判定也必须如此；
    // 较晚的有限读取不应覆盖较早的「读到末尾」读取
    const messages: ChatMessage[] = [
      asst('r1', 'read', readArgs({ limit: 0 })),
      tool('r1', 'full from start'),
      asst('r2', 'read', readArgs({ offset: 0, limit: 100 })),
      tool('r2', 'partial')
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

  it('bash cat 不走 idempotent_snapshot：两次相同参数均不覆盖', () => {
    const messages: ChatMessage[] = [
      asst('b1', 'bash', bashArgs('cat src/foo.ts')),
      tool('b1', 'before edit'),
      asst('b2', 'bash', bashArgs('cat src/foo.ts')),
      tool('b2', 'after edit')
    ]
    const plan = planToolResultSupersession(messages)
    expect(plan.size).toBe(0)
  })

  it('bash head / find 不走 idempotent_snapshot', () => {
    const headMessages: ChatMessage[] = [
      asst('h1', 'bash', bashArgs('head -n 20 src/foo.ts')),
      tool('h1', 'head 1'),
      asst('h2', 'bash', bashArgs('head -n 20 src/foo.ts')),
      tool('h2', 'head 2')
    ]
    expect(planToolResultSupersession(headMessages).size).toBe(0)

    const findMessages: ChatMessage[] = [
      asst('f1', 'bash', bashArgs('find src -name *.ts')),
      tool('f1', 'find 1'),
      asst('f2', 'bash', bashArgs('find src -name *.ts')),
      tool('f2', 'find 2')
    ]
    expect(planToolResultSupersession(findMessages).size).toBe(0)
  })

  it('bash ls 不走 idempotent_snapshot（一等 ls 工具不在本用例）', () => {
    const messages: ChatMessage[] = [
      asst('b1', 'bash', bashArgs('ls src')),
      tool('b1', 'listing 1'),
      asst('b2', 'bash', bashArgs('ls src')),
      tool('b2', 'listing 2')
    ]
    const plan = planToolResultSupersession(messages)
    expect(plan.size).toBe(0)
  })

  it('git -C 路径的 status 仍走 idempotent_snapshot', () => {
    const messages: ChatMessage[] = [
      asst('b1', 'bash', bashArgs('git -C some/path status')),
      tool('b1', 'status 1'),
      asst('b2', 'bash', bashArgs('git -C some/path status')),
      tool('b2', 'status 2')
    ]
    const plan = planToolResultSupersession(messages)
    expect(plan.get('b1')).toBe('idempotent_snapshot')
    expect(plan.has('b2')).toBe(false)
  })

  it('git diff test 仍走 idempotent_snapshot（路径 token 含 test 不误伤）', () => {
    const messages: ChatMessage[] = [
      asst('b1', 'bash', bashArgs('git diff test')),
      tool('b1', 'diff 1'),
      asst('b2', 'bash', bashArgs('git diff test')),
      tool('b2', 'diff 2')
    ]
    const plan = planToolResultSupersession(messages)
    expect(plan.get('b1')).toBe('idempotent_snapshot')
    expect(plan.has('b2')).toBe(false)
  })

  it('git status 重定向不走 idempotent_snapshot', () => {
    const messages: ChatMessage[] = [
      asst('b1', 'bash', bashArgs('git status > out')),
      tool('b1', 'status 1'),
      asst('b2', 'bash', bashArgs('git status > out')),
      tool('b2', 'status 2')
    ]
    const plan = planToolResultSupersession(messages)
    expect(plan.size).toBe(0)
  })

  it('git status 命令替换不走 idempotent_snapshot', () => {
    const subMessages: ChatMessage[] = [
      asst('s1', 'bash', bashArgs('git status $(echo x)')),
      tool('s1', 'status 1'),
      asst('s2', 'bash', bashArgs('git status $(echo x)')),
      tool('s2', 'status 2')
    ]
    expect(planToolResultSupersession(subMessages).size).toBe(0)

    const tickMessages: ChatMessage[] = [
      asst('t1', 'bash', bashArgs('git status `echo x`')),
      tool('t1', 'status 1'),
      asst('t2', 'bash', bashArgs('git status `echo x`')),
      tool('t2', 'status 2')
    ]
    expect(planToolResultSupersession(tickMessages).size).toBe(0)
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
