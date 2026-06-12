/**
 * subagentsHandler — validateSpec 内置名保护
 */
import { describe, expect, it } from 'vitest'
import { validateSpec } from '../../../src/main/ipc/subagentsHandler'

describe('validateSpec', () => {
  it('拒绝与内置子代理同名的自定义 spec', () => {
    expect(() =>
      validateSpec({
        name: 'explore',
        description: 'dup',
        allowedTools: ['read'],
        prompt: 'test'
      })
    ).toThrow(/内置/)
  })

  it('合法自定义 spec 不抛错', () => {
    expect(() =>
      validateSpec({
        name: 'my-agent',
        description: '自定义',
        allowedTools: ['read', 'grep'],
        prompt: 'do work'
      })
    ).not.toThrow()
  })
})
