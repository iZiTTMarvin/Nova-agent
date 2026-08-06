import { describe, expect, it } from 'vitest'
import {
  estimateNextRequestTokens,
  exceedsHighWater,
  measureRequestPayloadChars
} from '../../../../src/runtime/agent/compaction/estimateNextRequestTokens'
import { CHARS_PER_TOKEN } from '../../../../src/runtime/agent/tokenEstimator'
import { resolveProductionBudgetLimits } from '../../../../src/runtime/agent/ContextBudgetManager'

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
  it('对消息序列做 JSON 字节计量', () => {
    const messages = [{ role: 'user' as const, content: 'hello' }]
    expect(measureRequestPayloadChars(messages)).toBe(
      Buffer.byteLength(JSON.stringify(messages), 'utf8')
    )
  })
})
