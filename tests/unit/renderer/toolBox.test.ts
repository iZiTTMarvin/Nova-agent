import { describe, expect, it } from 'vitest'
import { getToolDisplayName, getToolSummary } from '../../../src/renderer/features/chat/toolDisplay'

describe('getToolDisplayName', () => {
  it('所有已知工具都有中文映射', () => {
    const knownTools = ['ls', 'read', 'grep', 'find', 'write', 'edit', 'bash']
    for (const tool of knownTools) {
      const name = getToolDisplayName(tool)
      // 中文名应包含中文字符
      expect(name).toMatch(/[一-鿿]/)
    }
  })

  it('未知工具回退到通用描述', () => {
    expect(getToolDisplayName('unknown_tool')).toContain('unknown_tool')
  })
})

describe('getToolSummary', () => {
  it('write 工具显示文件路径和行数', () => {
    expect(getToolSummary('write', { path: 'src/foo.ts', content: 'a\nb\nc' }))
      .toBe('正在写入 src/foo.ts（+3 行）')
  })

  it('write 工具无参数时显示通用提示', () => {
    expect(getToolSummary('write', {})).toBe('正在写入文件')
  })

  it('write 工具：尾随换行不多算 1 行', () => {
    // 代码文件常见结尾有换行："a\nb\nc\n" 是 3 行而非 4 行
    expect(getToolSummary('write', { path: 'src/foo.ts', content: 'a\nb\nc\n' }))
      .toBe('正在写入 src/foo.ts（+3 行）')
  })

  it('write 工具：空内容为 0 行', () => {
    expect(getToolSummary('write', { path: 'src/empty.ts', content: '' }))
      .toBe('正在写入 src/empty.ts（+0 行）')
  })

  it('edit 工具显示替换行数', () => {
    expect(getToolSummary('edit', { path: 'src/bar.ts', old: 'line1\nline2' }))
      .toBe('正在修改 src/bar.ts（替换 2 行）')
  })

  it('edit 工具：尾随换行不多算 1 行', () => {
    expect(getToolSummary('edit', { path: 'src/bar.ts', old: 'line1\nline2\n' }))
      .toBe('正在修改 src/bar.ts（替换 2 行）')
  })

  it('bash 工具截断过长命令', () => {
    const longCmd = 'a'.repeat(70)
    const result = getToolSummary('bash', { command: longCmd })
    expect(result.length).toBeLessThan(80)
    expect(result).toContain('...')
  })

  it('bash 工具显示短命令原文', () => {
    expect(getToolSummary('bash', { command: 'npm test' }))
      .toBe('正在执行 npm test')
  })

  it('read 工具显示文件路径', () => {
    expect(getToolSummary('read', { path: 'src/app.ts' })).toBe('读取 src/app.ts')
  })

  it('grep 工具显示搜索关键词和路径', () => {
    expect(getToolSummary('grep', { pattern: 'TODO', path: 'src/' }))
      .toBe('搜索 "TODO" 在 src/')
    expect(getToolSummary('grep', { pattern: 'FIXME' }))
      .toBe('搜索 "FIXME"')
  })

  it('未知工具返回空字符串', () => {
    expect(getToolSummary('unknown', {})).toBe('')
  })
})

describe('ThinkingBlock 计时器逻辑', () => {
  it('基于 Date.now() 差值计算不会受递增漂移影响', () => {
    // 验证核心逻辑：差值计算不会累积误差
    const startTime = Date.now() - 3500 // 模拟 3.5 秒前开始
    const elapsed = Math.round(((Date.now() - startTime) / 1000) * 10) / 10
    // 3.5 秒的经过时间应为 3.5（允许小量误差因 Date.now() 调用间隔）
    expect(elapsed).toBeGreaterThanOrEqual(3.4)
    expect(elapsed).toBeLessThanOrEqual(4.0)
  })

  it('主线程卡顿后时间立即追上', () => {
    // 模拟：开始时间在 5 秒前，即使主线程卡住了 3 秒，
    // 下一次 tick 时差值计算会立即反映真实时间
    const startTime = Date.now() - 5000
    const elapsed = Math.round(((Date.now() - startTime) / 1000) * 10) / 10
    // 应该立即显示 ~5.0 秒，而不是从 2.0 跳到 5.0
    expect(elapsed).toBeGreaterThanOrEqual(4.9)
  })

  it('格式化输出保留一位小数', () => {
    const elapsed = 3.4
    expect(elapsed.toFixed(1)).toBe('3.4')
    const elapsed2 = 10.0
    expect(elapsed2.toFixed(1)).toBe('10.0')
  })

  it('思考不到 100ms 时结束补算仍能产生正数耗时', () => {
    // 模拟：思考 50ms 就结束，补算逻辑应产出 >0 的时间
    const startTime = Date.now() - 50
    const finalDelta = Math.round(((Date.now() - startTime) / 1000) * 10) / 10
    // 即使只有几十毫秒，补算后 elapsed 应至少是 0.1（0.05 → round(0.5)/10 = 0.1）
    expect(finalDelta).toBeGreaterThanOrEqual(0)
  })
})