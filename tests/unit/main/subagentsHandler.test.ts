/**
 * subagentsHandler — validateSpec 内置名保护
 */
import { describe, expect, it } from 'vitest'
import { validateSpec } from '../../../src/main/ipc/subagentsHandler'

describe('validateSpec', () => {
  const baseSpec = {
    name: 'my-agent',
    description: '自定义',
    allowedTools: ['read'],
    prompt: 'do work'
  }

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
        ...baseSpec,
        model: {
          providerId: 'provider-a',
          modelEntryId: 'model-a',
          reasoningEffort: 'high'
        }
      })
    ).not.toThrow()
  })

  it.each([
    {
      name: 'legacy model binding',
      model: { providerId: 'provider-a', modelId: 'api-model-a' }
    },
    {
      name: 'mixed legacy and new fields',
      model: { providerId: 'provider-a', modelEntryId: 'model-a', modelId: 'api-model-a' }
    },
    {
      name: 'invalid reasoning effort',
      model: { providerId: 'provider-a', modelEntryId: 'model-a', reasoningEffort: 'extreme' }
    }
  ])('$name is rejected at the IPC validation boundary', ({ model }) => {
    expect(() => validateSpec({ ...baseSpec, model })).toThrow()
  })
})
