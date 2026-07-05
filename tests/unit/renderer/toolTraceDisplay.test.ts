/**
 * L3 原子行 Action / Target 文案
 */
import { describe, expect, it } from 'vitest'
import {
  getToolTraceAction,
  getToolTraceTarget,
  getToolGroupTraceParts
} from '../../../src/renderer/features/chat/toolTraceDisplay'

describe('getToolTraceAction', () => {
  it('映射常见工具为短英文动词', () => {
    expect(getToolTraceAction('read')).toBe('Read')
    expect(getToolTraceAction('bash')).toBe('Ran')
    expect(getToolTraceAction('edit')).toBe('Edited')
    expect(getToolTraceAction('write')).toBe('Wrote')
    expect(getToolTraceAction('grep')).toBe('Grepped')
  })
})

describe('getToolTraceTarget', () => {
  it('read / bash 截断过长 target', () => {
    expect(getToolTraceTarget('read', { path: 'src/a.ts' })).toBe('src/a.ts')
    expect(getToolTraceTarget('bash', { command: 'npm test' })).toBe('npm test')

    const longCmd = 'x'.repeat(100)
    const target = getToolTraceTarget('bash', { command: longCmd })
    expect(target.length).toBeLessThanOrEqual(72)
    expect(target.endsWith('...')).toBe(true)
  })

  it('write 附带行数', () => {
    expect(getToolTraceTarget('write', { path: 'a.ts', content: 'a\nb\nc' })).toBe('a.ts +3')
  })
})

describe('getToolGroupTraceParts', () => {
  it('聚合 read 使用同一 Action 语言', () => {
    const parts = getToolGroupTraceParts('read', [
      { arguments: { path: 'src/foo.ts' } },
      { arguments: { path: 'b.ts' } }
    ])
    expect(parts).toEqual({
      action: 'Read',
      target: 'foo.ts',
      suffix: '等 2 个文件'
    })
  })
})
