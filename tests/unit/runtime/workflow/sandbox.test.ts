import { describe, it, expect } from 'vitest'
import { evalScript } from '../../../../src/runtime/workflow/sandbox'

describe('workflow sandbox', () => {
  it('拒绝访问 require', async () => {
    await expect(
      evalScript('require("fs")', {}, { deadlineMs: 2000 })
    ).rejects.toThrow(/require|denied|not available|sandbox/i)
  })

  it('拒绝访问 process', async () => {
    await expect(
      evalScript('process.exit(0)', {}, { deadlineMs: 2000 })
    ).rejects.toThrow(/process|denied|not available|sandbox/i)
  })

  it('拒绝访问 fs', async () => {
    await expect(
      evalScript('fs.readFileSync("/etc/passwd")', {}, { deadlineMs: 2000 })
    ).rejects.toThrow(/fs|denied|not available|sandbox/i)
  })

  it('拒绝 Function 构造逃逸', async () => {
    await expect(
      evalScript(
        `({}).constructor.constructor("return process")()`,
        {},
        { deadlineMs: 2000 }
      )
    ).rejects.toThrow()
  })

  it('可调用注入的 host hook 并返回结果', async () => {
    const result = await evalScript(
      `const x = await agent("hi"); return { x };`,
      {
        agent: async (prompt) => `echo:${prompt}`
      },
      { deadlineMs: 2000 }
    )
    expect(result).toEqual({ x: 'echo:hi' })
  })

  it('args 注入为纯数据', async () => {
    const result = await evalScript(`return args;`, {}, {
      deadlineMs: 2000,
      args: { task: 'hello' }
    })
    expect(result).toEqual({ task: 'hello' })
  })
})
