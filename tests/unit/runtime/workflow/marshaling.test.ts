import { describe, it, expect } from 'vitest'
import { evalScript } from '../../../../src/runtime/workflow/sandbox'
import { marshalOut, assertPlainData } from '../../../../src/runtime/workflow/marshal'

describe('workflow marshaling', () => {
  it('host 返回值是纯数据，JSON.stringify 不抛错', async () => {
    const result = await evalScript(
      `return await agent("x");`,
      {
        agent: async () => ({ a: 1, b: ['t'], nested: { ok: true } })
      },
      { deadlineMs: 2000 }
    )
    expect(() => assertPlainData(result)).not.toThrow()
    expect(result).toEqual({ a: 1, b: ['t'], nested: { ok: true } })
  })

  it('host 直接返回函数时抛错', async () => {
    await expect(
      evalScript(
        `return await agent("x");`,
        {
          agent: async () => (() => 1) as unknown as string
        },
        { deadlineMs: 2000 }
      )
    ).rejects.toThrow(/marshal|JSON|serializ|non-JSON/i)
  })

  it('对象上的函数字段被剥离，结果仍是纯数据', async () => {
    const result = await evalScript(
      `return await agent("x");`,
      {
        agent: async () => ({ a: 1, fn: () => 2 }) as unknown as Record<string, unknown>
      },
      { deadlineMs: 2000 }
    )
    expect(result).toEqual({ a: 1 })
    expect(() => assertPlainData(result)).not.toThrow()
  })

  it('marshalOut 剥离原型上的方法', () => {
    class Foo {
      x = 1
      method() {
        return 2
      }
    }
    const out = marshalOut(new Foo()) as { x: number; method?: unknown }
    expect(out).toEqual({ x: 1 })
    expect(out.method).toBeUndefined()
    expect(() => JSON.stringify(out)).not.toThrow()
  })

  it('null / 原始类型原样通过', () => {
    expect(marshalOut(null)).toBeNull()
    expect(marshalOut('s')).toBe('s')
    expect(marshalOut(42)).toBe(42)
    expect(marshalOut(true)).toBe(true)
  })
})
