import { describe, it, expect } from 'vitest'
import { flushCurrentSessionOnQuit } from '../../../src/main/services/MemoryConsolidationHost'

describe('退出路径记忆落盘', () => {
  it('缺少 sessionId 时静默跳过', () => {
    expect(() => flushCurrentSessionOnQuit(null, '/ws')).not.toThrow()
  })

  it('缺少 workspaceRoot 时静默跳过', () => {
    expect(() => flushCurrentSessionOnQuit('sess_x', null)).not.toThrow()
  })
})
