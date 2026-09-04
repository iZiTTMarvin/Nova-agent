import { describe, it, expect } from 'vitest'
import {
  shouldCompact,
  buildCompactionPrompt,
  buildCompactionRequestTail,
  buildStateInstruction,
  boundSummaryText,
  foldLedgerEntriesToBudget,
  splitForCompactionByTokens,
  truncateStateFromEnd,
  rebuildWithCompression,
  rollbackBefore,
  COMPACTION_THRESHOLD,
  MAX_SUMMARY_ESTIMATED_TOKENS,
  SOFT_COMPACTION_COOLDOWN_TURNS,
  estimateToolMessageTokens,
} from '../../../../src/runtime/agent/compaction/compaction'
import { renderHandoffPacket, renderLedgerEntry, formatPointerStub } from '../../../../src/runtime/agent/core/renderHandoffPacket'
import { makeCompactionLedger } from '../../../../src/test-support/builders/compactionLedger'
import {
  CHARS_PER_TOKEN,
  estimateTokens,
  estimateContextTokens
} from '../../../../src/runtime/agent/tokenEstimator'
import { extractTextFromContent } from '../../../../src/runtime/model/types'
import type { ChatMessage } from '../../../../src/runtime/model/types'

function makeMessages(count: number, contentLength = 100): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'system prompt' }
  ]
  for (let i = 0; i < count; i++) {
    messages.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'x'.repeat(contentLength)
    })
  }
  return messages
}

describe('tokenEstimator', () => {
  it('空字符串返回 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('粗略估算 token 数', () => {
    expect(estimateTokens('hello world')).toBe(3) // 11 chars / 4 = 2.75 → 3
    expect(estimateTokens('a'.repeat(400))).toBe(100)
  })

  it('estimateContextTokens 累加所有消息', () => {
    const messages = [
      { content: 'a'.repeat(100) },
      { content: 'b'.repeat(200) },
      { content: 'c'.repeat(300) }
    ]
    expect(estimateContextTokens(messages)).toBe(150) // (100+200+300)/4
  })
})

describe('compaction', () => {
  describe('shouldCompact', () => {
    it('消息数不足时不触发', () => {
      const messages = makeMessages(10)
      expect(shouldCompact(messages)).toBe(false)
    })

    it('token 数未达阈值时不触发', () => {
      const messages = makeMessages(30, 100)
      expect(shouldCompact(messages)).toBe(false)
    })

    it('token 数超过阈值时触发', () => {
      // 30 条消息 × 20000 字符 = 600000 字符 → 150000 tokens > 120000
      const messages = makeMessages(30, 20000)
      expect(shouldCompact(messages)).toBe(true)
    })

    it('自定义阈值生效', () => {
      const messages = makeMessages(30, 100)
      expect(shouldCompact(messages, 1)).toBe(true)
    })

    it('软触发：工具 45% + 总窗口 65% + 冷却 5 回合 → 触发', () => {
      const threshold = 10_000
      const messages: ChatMessage[] = [{ role: 'system', content: 's'.repeat(400) }]
      for (let i = 0; i < 12; i++) {
        messages.push({ role: 'user', content: `u${i} ` + 'a'.repeat(300) })
        messages.push({
          role: 'assistant',
          content: 'run',
          toolCalls: [{ id: `tc${i}`, name: 'bash', arguments: '{}' }]
        })
        messages.push({
          role: 'tool',
          content: 't'.repeat(1600),
          toolCallId: `tc${i}`
        })
      }
      for (let i = 0; i < 8; i++) {
        messages.push({ role: 'user', content: 'f'.repeat(400) })
        messages.push({ role: 'assistant', content: 'g'.repeat(400) })
      }

      const totalTokens = estimateContextTokens(messages)
      const toolTokens = estimateToolMessageTokens(messages)
      expect(toolTokens).toBeGreaterThan(threshold * 0.4)
      expect(totalTokens).toBeGreaterThan(threshold * 0.6)
      expect(totalTokens).toBeLessThanOrEqual(threshold)

      expect(shouldCompact(messages, threshold, totalTokens, SOFT_COMPACTION_COOLDOWN_TURNS)).toBe(true)
    })

    it('软触发：总窗口未达 60% 时不触发（即使工具占比高）', () => {
      const threshold = 10_000
      const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }]
      for (let i = 0; i < 12; i++) {
        messages.push({ role: 'user', content: `u${i}` })
        messages.push({
          role: 'assistant',
          content: 'x',
          toolCalls: [{ id: `tc${i}`, name: 'grep', arguments: '{}' }]
        })
        messages.push({
          role: 'tool',
          content: 'g'.repeat(1700),
          toolCallId: `tc${i}`
        })
      }
      const totalTokens = estimateContextTokens(messages)
      const toolTokens = estimateToolMessageTokens(messages)
      expect(toolTokens).toBeGreaterThan(threshold * 0.4)
      expect(totalTokens).toBeLessThan(threshold * 0.6)

      expect(shouldCompact(messages, threshold, totalTokens, SOFT_COMPACTION_COOLDOWN_TURNS)).toBe(false)
    })

    it('软触发：冷却不足 5 user 回合时不触发', () => {
      const threshold = 10_000
      const messages: ChatMessage[] = [{ role: 'system', content: 's'.repeat(400) }]
      for (let i = 0; i < 12; i++) {
        messages.push({ role: 'user', content: `u${i} ` + 'a'.repeat(300) })
        messages.push({
          role: 'assistant',
          content: 'run',
          toolCalls: [{ id: `tc${i}`, name: 'bash', arguments: '{}' }]
        })
        messages.push({
          role: 'tool',
          content: 't'.repeat(1600),
          toolCallId: `tc${i}`
        })
      }
      for (let i = 0; i < 8; i++) {
        messages.push({ role: 'user', content: 'f'.repeat(400) })
        messages.push({ role: 'assistant', content: 'g'.repeat(400) })
      }
      const totalTokens = estimateContextTokens(messages)
      expect(shouldCompact(messages, threshold, totalTokens, 3)).toBe(false)
    })

    it('硬 cap 超阈值时无视冷却立即触发', () => {
      const messages = makeMessages(30, 20000)
      expect(shouldCompact(messages, COMPACTION_THRESHOLD, undefined, 0)).toBe(true)
    })
  })

  describe('buildCompactionPrompt', () => {
    it('包含摘要要求', () => {
      const prompt = buildCompactionPrompt()
      expect(prompt).toContain('摘要')
    })

    it('不要求模型写工作区路径', () => {
      const prompt = buildCompactionPrompt()
      expect(prompt).toContain('不要写 Working directory')
      expect(prompt).not.toContain('摘要开头先用一行注明当前工作区')
    })

    it('包含 artifact:// 感知提示', () => {
      const prompt = buildCompactionPrompt()
      expect(prompt).toContain('artifact://')
      expect(prompt).toContain('只保留结论')
    })

    it('包含五个固定段标题', () => {
      const prompt = buildCompactionPrompt()
      expect(prompt).toContain('## 目标')
      expect(prompt).toContain('## 进展')
      expect(prompt).toContain('## 关键决策')
      expect(prompt).toContain('## 下一步')
      expect(prompt).toContain('## 关键上下文')
    })

    it('进展分已完成与进行中两个子列表，下一步为有序列表', () => {
      const prompt = buildCompactionPrompt()
      expect(prompt).toContain('已完成')
      expect(prompt).toContain('进行中')
      expect(prompt).toContain('有序列表')
    })

    it('关键上下文要求精确路径与错误信息，缺失时写 (none)', () => {
      const prompt = buildCompactionPrompt()
      expect(prompt).toContain('文件路径')
      expect(prompt).toContain('错误信息')
      expect(prompt).toContain('(none)')
    })

    it('只输出摘要：不继续对话、不复述、不加前缀说明', () => {
      const prompt = buildCompactionPrompt()
      expect(prompt).toContain('不要继续对话')
      expect(prompt).toContain('只输出摘要')
      expect(prompt).toContain('不要加任何前缀说明')
    })
  })

  describe('boundSummaryText', () => {
    it('未超限的摘要原样返回', () => {
      const summary = '## 目标\n完成压缩协议\n## 下一步\n1. 继续'
      expect(boundSummaryText(summary)).toBe(summary)
    })

    it('超过 768 估算 token 的摘要被截断到字符上限内并带省略标记', () => {
      const maxChars = MAX_SUMMARY_ESTIMATED_TOKENS * CHARS_PER_TOKEN
      const summary = Array.from({ length: 100 }, () => 'x'.repeat(100)).join('\n')
      expect(summary.length).toBeGreaterThan(maxChars)

      const bounded = boundSummaryText(summary)
      expect(bounded.endsWith('\n…[摘要已截断]')).toBe(true)
      expect(bounded.length).toBeLessThanOrEqual(maxChars + '\n…[摘要已截断]'.length)
    })

    it('截断发生在行边界，不产生半行', () => {
      const summary = Array.from({ length: 50 }, (_, i) => `line-${i}-` + 'y'.repeat(90)).join('\n')
      const bounded = boundSummaryText(summary)
      const body = bounded.slice(0, bounded.indexOf('\n…[摘要已截断]'))
      for (const line of body.split('\n')) {
        expect(line).toMatch(/^line-\d+-y+$/)
      }
    })

    it('无换行的超长文本在上限处硬截', () => {
      const maxChars = MAX_SUMMARY_ESTIMATED_TOKENS * CHARS_PER_TOKEN
      const summary = 'z'.repeat(maxChars + 500)
      expect(boundSummaryText(summary)).toBe('z'.repeat(maxChars) + '\n…[摘要已截断]')
    })

    it('自定义 maxTokens 生效，且有 80 字符下限', () => {
      const summary = 'a'.repeat(200)
      expect(boundSummaryText(summary, 10)).toBe('a'.repeat(80) + '\n…[摘要已截断]')
    })
  })

  describe('rebuildWithCompression', () => {
    it('重建后第一条是冻结 prompt 加上交接包', () => {
      const ledger = makeCompactionLedger({ summary: 'summary' })
      const result = rebuildWithCompression('system', ledger, [])
      expect(result).toHaveLength(1)
      expect(result[0].role).toBe('system')
      expect(result[0].content).toContain('system')
      expect(result[0].content).toContain('summary')
      expect(String(result[0].content)).not.toContain('[对话历史摘要]')
    })

    it('摘要在交接包中，保持冻结 prompt 前缀稳定', () => {
      const ledger = makeCompactionLedger({ summary: '之前讨论了架构设计' })
      const result = rebuildWithCompression('你是编程助手', ledger, [])
      expect(String(result[0].content).startsWith('你是编程助手')).toBe(true)
      expect(result[0].content).toContain('之前讨论了架构设计')
      expect(result).toHaveLength(1)
    })

    it('重建后最近消息追加在 system 之后', () => {
      const recent: ChatMessage[] = [
        { role: 'user', content: '最近问题' },
        { role: 'assistant', content: '最近回复' }
      ]
      const result = rebuildWithCompression('system', makeCompactionLedger({ summary: 'summary' }), recent)
      expect(result).toHaveLength(3)
      expect(result[1]).toEqual(recent[0])
      expect(result[2]).toEqual(recent[1])
    })

    it('尾部可以包含 pulled-back 消息', () => {
      const recent: ChatMessage[] = [{ role: 'user', content: 'recent' }]
      const pb: ChatMessage[] = [{ role: 'assistant', content: 'pulled' }]
      const result = rebuildWithCompression(
        'system',
        makeCompactionLedger({ summary: 'summary' }),
        [...recent, ...pb]
      )
      expect(result).toHaveLength(3)
      expect(result[2]).toEqual(pb[0])
    })

    it('同一账本渲染两次交接包字节相同', () => {
      const ledger = makeCompactionLedger({ summary: '冻结 state' })
      expect(renderHandoffPacket(ledger)).toBe(renderHandoffPacket(ledger))
    })
  })

  describe('rollbackBefore', () => {
    it('回滚到指定索引之前', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' }
      ]
      const result = rollbackBefore(messages, 2)
      expect(result).toHaveLength(2)
      expect(result[0]).toEqual(messages[0])
      expect(result[1]).toEqual(messages[1])
    })

    it('越界或负数索引返回原 context', () => {
      const messages = makeMessages(3)
      expect(rollbackBefore(messages, -1)).toEqual(messages)
      expect(rollbackBefore(messages, 10)).toEqual(messages)
    })
  })

  describe('buildCompactionRequestTail', () => {
    it('末尾是 user 时插入 assistant 桥接（避免连续 user）', () => {
      const tail = buildCompactionRequestTail('user', '指令')
      expect(tail).toHaveLength(2)
      expect(tail[0].role).toBe('assistant')
      expect(tail[0].content).toBe('好的，我来总结之前的对话。')
      expect(tail[1].role).toBe('user')
    })

    it('末尾是 assistant 时不插入桥接', () => {
      const tail = buildCompactionRequestTail('assistant', '指令')
      expect(tail).toHaveLength(1)
      expect(tail[0].role).toBe('user')
    })

    it('末尾是 tool 时不插入桥接', () => {
      const tail = buildCompactionRequestTail('tool', '指令')
      expect(tail).toHaveLength(1)
      expect(tail[0].role).toBe('user')
    })

    it('上下文为空（role 为 undefined）时不插入桥接', () => {
      const tail = buildCompactionRequestTail(undefined, '指令')
      expect(tail).toHaveLength(1)
      expect(tail[0].role).toBe('user')
    })

    it('压缩指令消息标记 internal，正文与传入指令一致', () => {
      const instruction = buildCompactionPrompt()
      const tail = buildCompactionRequestTail('user', instruction)
      const last = tail[tail.length - 1]
      expect(last.internal).toBe(true)
      expect(last.content).toBe(instruction)
    })

    it('传入 previousSummary 时指令包含前序摘要与增量更新要求', () => {
      const tail = buildCompactionRequestTail('assistant', buildStateInstruction('前一版摘要内容'))
      const instruction = tail[tail.length - 1]
      expect(instruction.internal).toBe(true)
      const text = extractTextFromContent(instruction.content)
      expect(text).toContain('## 目标')
      expect(text).toContain('## 关键上下文')
      expect(text).toContain('前序摘要')
      expect(text).toContain('前一版摘要内容')
      expect(text).toContain('不要推翻重写')
    })

    it('首次压缩（无 previousSummary）指令不含前序摘要段', () => {
      const tail = buildCompactionRequestTail('assistant', buildStateInstruction())
      const instruction = tail[tail.length - 1]
      expect(extractTextFromContent(instruction.content)).not.toContain('前序摘要')
      expect(instruction.content).toBe(buildCompactionPrompt())
    })

    it('传入 previousSummary 时保留 user 结尾的 assistant 桥接', () => {
      const tail = buildCompactionRequestTail('user', buildStateInstruction('前一版摘要内容'))
      expect(tail).toHaveLength(2)
      expect(tail[0].role).toBe('assistant')
      expect(extractTextFromContent(tail[1].content)).toContain('前一版摘要内容')
    })
  })

  describe('splitForCompactionByTokens', () => {
    it('按 token 预算保留尾部且不拆工具组', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 's' },
        { role: 'user', content: 'x'.repeat(400) },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
        },
        { role: 'tool', content: 'result', toolCallId: 'c1' },
        { role: 'user', content: 'tail' }
      ]
      const { oldMessages, recentMessages } = splitForCompactionByTokens(messages, 20)
      expect(recentMessages.some(m => m.role === 'tool' && m.toolCallId === 'c1')).toBe(
        recentMessages.some(m => m.role === 'assistant' && m.toolCalls?.[0]?.id === 'c1')
      )
      expect(oldMessages[0]?.role).toBe('user')
      expect(recentMessages[0]?.role).toBe('assistant')
      expect(oldMessages.concat(recentMessages).map(m => m.content)).toEqual(
        messages.filter(m => m.role !== 'system').map(m => m.content)
      )
    })
  })

  describe('truncateStateFromEnd', () => {
    it('超预算时从末尾丢掉关键决策，保住下一步', () => {
      const text = [
        '## 目标',
        '完成压缩',
        '## 下一步',
        '1. 继续',
        '## 关键上下文',
        '(none)',
        '## 进展',
        '- 已完成: 设计',
        '## 关键决策',
        '- 采用账本'
      ].join('\n')
      const truncated = truncateStateFromEnd(text, 8)
      expect(truncated).toContain('## 下一步')
      expect(truncated).not.toContain('## 关键决策')
    })
  })

  describe('foldLedgerEntriesToBudget', () => {
    it('超预算时从最旧条目起折成指针，保留 id', () => {
      const origin = { messageId: 'm', step: 0 }
      const entries = [
        { id: 'c1', shadows: { from: origin, to: origin }, stub: 'long stub one ' + 'x'.repeat(400), touchedFiles: { paths: [], omittedCount: 0 }, trigger: 'threshold' as const, createdAt: 1 },
        { id: 'c2', shadows: { from: origin, to: origin }, stub: 'long stub two ' + 'y'.repeat(400), touchedFiles: { paths: [], omittedCount: 0 }, trigger: 'threshold' as const, createdAt: 2 }
      ]
      const folded = foldLedgerEntriesToBudget(entries, 150)
      expect(folded[0]!.stub).toBe(formatPointerStub('c1', origin, origin))
      expect(folded[0]!.id).toBe('c1')
      expect(folded[1]!.stub).toContain('long stub two')
    })

    it('预算为 0 时全部折成指针', () => {
      const origin = { messageId: 'm', step: 1 }
      const entries = [
        { id: 'c1', shadows: { from: origin, to: origin }, stub: 'keep me', touchedFiles: { paths: [], omittedCount: 0 }, trigger: 'idle' as const, createdAt: 1 }
      ]
      expect(foldLedgerEntriesToBudget(entries, 0)[0]!.stub).toBe(formatPointerStub('c1', origin, origin))
    })

    it('touchedFiles 计入条目渲染预算，折成指针后不再渲染文件清单', () => {
      const origin = { messageId: 'm', step: 0 }
      const entries = [
        {
          id: 'c1',
          shadows: { from: origin, to: origin },
          stub: 'short',
          touchedFiles: { paths: ['src/' + 'a'.repeat(400) + '.ts'], omittedCount: 0 },
          trigger: 'threshold' as const,
          createdAt: 1
        },
        {
          id: 'c2',
          shadows: { from: origin, to: origin },
          stub: 'keep',
          touchedFiles: { paths: [], omittedCount: 0 },
          trigger: 'threshold' as const,
          createdAt: 2
        }
      ]
      const folded = foldLedgerEntriesToBudget(entries, 40)
      expect(folded[0]!.stub).toBe(formatPointerStub('c1', origin, origin))
      expect(folded[0]!.touchedFiles.paths[0]).toContain('src/')
      expect(renderLedgerEntry(folded[0]!)).toBe(formatPointerStub('c1', origin, origin))
      expect(folded[1]!.stub).toBe('keep')
    })
  })
})
