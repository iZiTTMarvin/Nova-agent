import { describe, expect, it } from 'vitest'
import { resolveHeadlessMaxToolRounds } from '../../../src/headless/roundBudget'

describe('headless round budget', () => {
  it('uses the task deadline without an additional round limit', () => {
    expect(resolveHeadlessMaxToolRounds(undefined, 5385)).toBe(Number.POSITIVE_INFINITY)
  })

  it('preserves the local safety default when no deadline exists', () => {
    expect(resolveHeadlessMaxToolRounds(undefined, undefined)).toBe(100)
  })

  it('keeps an explicitly requested round limit', () => {
    expect(resolveHeadlessMaxToolRounds('250', 5385)).toBe(250)
  })

  it.each(['0', '-1', '1.5', 'invalid'])('rejects invalid explicit limits: %s', value => {
    expect(() => resolveHeadlessMaxToolRounds(value, 5385)).toThrow(
      '--max-tool-rounds 必须是正整数'
    )
  })
})
