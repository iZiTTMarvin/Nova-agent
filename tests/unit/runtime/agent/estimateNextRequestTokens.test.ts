import { describe, expect, it } from 'vitest'
import {
  estimateNextRequestTokens,
  exceedsHighWater,
  measureRequestPayloadChars
} from '../../../../src/runtime/agent/compaction/estimateNextRequestTokens'
import { CHARS_PER_TOKEN } from '../../../../src/runtime/agent/tokenEstimator'
import {
  ContextBudgetManager,
  createProductionContextBudgetManager,
  estimateContextSize,
  resolveProductionBudgetLimits
} from '../../../../src/runtime/agent/ContextBudgetManager'

describe('estimateNextRequestTokens', () => {
  it('有 usage 锚点时：inputTokens + 正 delta/换算比', () => {
    expect(
      estimateNextRequestTokens({
        priorUsageTokens: 1000,
        appendedChars: 40,
        charsPerToken: CHARS_PER_TOKEN
      })
    ).toBe(1010)
  })

  it('负 delta（压缩后缩小）不被高估', () => {
    expect(
      estimateNextRequestTokens({
        priorUsageTokens: 1000,
        appendedChars: -80,
        charsPerToken: CHARS_PER_TOKEN
      })
    ).toBe(980)
  })

  it('冷启动无锚点时回退到全量 payload 字符估算', () => {
    expect(
      estimateNextRequestTokens({
        appendedChars: 0,
        coldStartChars: 400,
        charsPerToken: CHARS_PER_TOKEN
      })
    ).toBe(100)
  })

  it('无 coldStartChars 时用 appendedChars 作冷启动', () => {
    expect(
      estimateNextRequestTokens({
        appendedChars: 12,
        charsPerToken: CHARS_PER_TOKEN
      })
    ).toBe(3)
  })
})

describe('exceedsHighWater / resolveProductionBudgetLimits', () => {
  it('高水位复用生产预算的 15% 预留公式', () => {
    const { reservedOutputTokens, highWaterTokens } = resolveProductionBudgetLimits({
      contextWindow: 8_000
    })
    expect(reservedOutputTokens).toBe(Math.min(8192, Math.floor(8_000 * 0.15)))
    expect(highWaterTokens).toBe(Math.max(1024, 8_000 - reservedOutputTokens))
    expect(exceedsHighWater(highWaterTokens, 8_000, reservedOutputTokens)).toBe(false)
    expect(exceedsHighWater(highWaterTokens + 1, 8_000, reservedOutputTokens)).toBe(true)
  })
})

describe('measureRequestPayloadChars', () => {
  it('对完整 JSON 计算字符数，token 与 UTF-8 字节诊断分别计量', () => {
    const messages = [{ role: 'user' as const, content: '中文图片说明🙂' }]
    const json = JSON.stringify(messages)
    expect(measureRequestPayloadChars(messages)).toBe(json.length)
    expect(estimateContextSize(messages)).toEqual({
      tokens: Math.ceil(json.length / CHARS_PER_TOKEN),
      bytes: Buffer.byteLength(json, 'utf8')
    })
  })

  it('生产高水位只扣一次输出预留，不以中文 UTF-8 字节数再次拦截', () => {
    const options = { contextWindow: 8_000 }
    const { highWaterTokens } = resolveProductionBudgetLimits(options)
    const overhead = JSON.stringify([{ role: 'user', content: '' }]).length
    const messages = [{
      role: 'user' as const,
      content: '中'.repeat(highWaterTokens * CHARS_PER_TOKEN - overhead)
    }]
    const manager = createProductionContextBudgetManager(options)
    expect(manager.enforceInline(messages)).toMatchObject({
      status: 'within_budget', estimatedTokens: highWaterTokens
    })
    expect(manager.enforceInline([{ ...messages[0], content: messages[0].content + '中' }]))
      .toMatchObject({ status: 'requires_compaction', estimatedTokens: highWaterTokens + 1 })
  })

  it('自定义字节硬限与输出预留仍保持原有语义', () => {
    const messages = [{ role: 'user' as const, content: '中文' }]
    const { tokens, bytes } = estimateContextSize(messages)
    expect(new ContextBudgetManager({ maxSerializedBytes: bytes }).enforceInline(messages).status)
      .toBe('within_budget')
    expect(new ContextBudgetManager({ maxSerializedBytes: bytes - 1 }).enforceInline(messages).status)
      .toBe('requires_compaction')
    expect(new ContextBudgetManager({
      maxEstimatedTokens: tokens, reservedOutputTokens: 1
    }).enforceInline(messages).status).toBe('requires_compaction')
  })
})
