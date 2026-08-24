/**
 * L3 原子行 Action / Target 文案
 */
import { describe, expect, it } from 'vitest'
import {
  getToolTraceAction,
  getToolTraceActionChinese,
  getToolTraceTarget,
  getToolGroupTraceParts,
  splitFilePath
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

describe('getToolTraceActionChinese', () => {
  it('映射常见工具为中文动词', () => {
    expect(getToolTraceActionChinese('read')).toBe('已读取')
    expect(getToolTraceActionChinese('bash')).toBe('已执行')
    expect(getToolTraceActionChinese('edit')).toBe('已编辑')
    expect(getToolTraceActionChinese('write')).toBe('已写入')
    expect(getToolTraceActionChinese('grep')).toBe('已搜索')
    expect(getToolTraceActionChinese('find')).toBe('已查找')
    expect(getToolTraceActionChinese('ls')).toBe('已列出')
  })
})

describe('splitFilePath', () => {
  it('正确拆解路径中的目录、文件名和后缀', () => {
    expect(splitFilePath('src/renderer/features/chat/ToolCallGroup.tsx')).toEqual({
      filename: 'ToolCallGroup.tsx',
      dir: 'src/renderer/features/chat/',
      ext: 'tsx'
    })
    expect(splitFilePath('README.md')).toEqual({
      filename: 'README.md',
      dir: '',
      ext: 'md'
    })
  })
})

describe('getToolGroupTraceParts', () => {
  it('探索摘要显示文件数量', () => {
    const parts = getToolGroupTraceParts('read', [
      { arguments: { path: 'src/foo.ts' } },
      { arguments: { path: 'b.ts' } }
    ])
    expect(parts).toEqual({
      action: '探索',
      target: '2 文件',
      suffix: ''
    })
  })
})
