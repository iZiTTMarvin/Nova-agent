/**
 * 阶段 0 护栏：发送前校验失败不得留下永久 active run。
 *
 * 当前缺陷（专家 P0-3）：startRun 在图片/regenerate 校验之前，异常落在 try/finally 外。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('P0-3 preflight 不得留下 active run', () => {
  it(
    'agentHandler：startRun 必须位于图片/regenerate 校验之后（源码顺序护栏）',
    () => {
      const src = readFileSync(
        join(__dirname, '../../../src/main/ipc/agentHandler.ts'),
        'utf-8'
      )

      const startRunIdx = src.indexOf('runCoordinator.startRun')
      expect(startRunIdx).toBeGreaterThan(0)

      const beforeStart = src.slice(0, startRunIdx)
      // 图片/regenerate 的 throw 文案必须出现在 startRun 之前
      expect(beforeStart).toMatch(/不支持图片|重新生成失败/)
      const hasPreflightCall =
        /preflightSendMessage|assertSendPreflight|validateSendParams/.test(beforeStart)
      const hasInlineChecks = /不支持图片|重新生成失败/.test(beforeStart)
      expect(hasPreflightCall || hasInlineChecks).toBe(true)
    }
  )

  it('契约：创建 run 后的所有出口必须 commitTerminal 恰好一次', () => {
    const src = readFileSync(
      join(__dirname, '../../../src/main/ipc/agentHandler.ts'),
      'utf-8'
    )
    // startRun 之后到 handler 结束之间，必须有统一 try/finally
    const afterStart = src.slice(src.indexOf('runCoordinator.startRun'))
    expect(afterStart).toMatch(/finally\s*\{/)
    expect(afterStart).toMatch(/commitTerminal/)
  })
})
