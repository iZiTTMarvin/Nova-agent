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
    expect(getToolTraceAction('task_wait')).toBe('Wait')
    expect(getToolTraceAction('batch_task')).toBe('Batch')
    expect(getToolTraceAction('subagent_read')).toBe('Inspect')
    expect(getToolTraceAction('task_followup')).toBe('Followup')
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

  it('子代理编排工具正确提取目标摘要', () => {
    expect(getToolTraceTarget('task_wait', { run_ids: ['run-1', 'run-2'] })).toBe('2 个子任务')
    expect(getToolTraceTarget('task_wait', { all_unfinished: true })).toBe('全部未完成子任务')
    expect(getToolTraceTarget('subagent_read', { child_session_id: 'sess_sub_1234567890', operation: 'search' })).toBe('sess_sub_123... (search)')
    expect(getToolTraceTarget('batch_task', { items: [{ task: '检查第一项' }, { task: '检查第二项' }] })).toBe('2 项: 检查第一项')
    expect(getToolTraceTarget('task_followup', { child_session_id: 'sess_sub_abc123', task: '继续深入分析' })).toBe('sess_sub...: 继续深入分析')
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
    expect(getToolTraceActionChinese('task_wait')).toBe('已等待')
    expect(getToolTraceActionChinese('batch_task')).toBe('已批处理')
    expect(getToolTraceActionChinese('subagent_read')).toBe('已回读')
    expect(getToolTraceActionChinese('task_followup')).toBe('已续跑')
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
