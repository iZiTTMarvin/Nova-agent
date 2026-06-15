import { describe, it, expect } from 'vitest'
import { buildSessionContext } from '../../../../src/runtime/agent/sessionContext'

describe('buildSessionContext', () => {
  it('生成符合 [Session context: ...] 格式的文本', () => {
    const text = buildSessionContext({
      workingDir: 'D:/proj/nova',
      model: 'gpt-4o',
      date: new Date('2026-06-15T10:00:00')
    })

    expect(text.startsWith('[Session context:')).toBe(true)
    expect(text.endsWith(']')).toBe(true)
    // 包含全部四个锚点字段
    expect(text).toContain('Today is 2026-06-15')
    expect(text).toContain('Current model: gpt-4o')
    expect(text).toContain('Working directory: D:/proj/nova')
    expect(text).toContain('OS:')
  })

  it('包含星期几', () => {
    // 2026-06-15 是 Monday
    const text = buildSessionContext({
      workingDir: '/tmp',
      model: 'm',
      date: new Date('2026-06-15T00:00:00')
    })
    expect(text).toContain('2026-06-15, Monday')
  })

  it('不同星期正确映射', () => {
    const cases: Array<[string, string]> = [
      ['2026-06-14', 'Sunday'],
      ['2026-06-15', 'Monday'],
      ['2026-06-16', 'Tuesday'],
      ['2026-06-17', 'Wednesday'],
      ['2026-06-18', 'Thursday'],
      ['2026-06-19', 'Friday'],
      ['2026-06-20', 'Saturday']
    ]
    for (const [iso, weekday] of cases) {
      const text = buildSessionContext({
        workingDir: '/x',
        model: 'm',
        date: new Date(`${iso}T12:00:00`)
      })
      expect(text).toContain(`, ${weekday}.`)
    }
  })

  it('日期零填充', () => {
    const text = buildSessionContext({
      workingDir: '/x',
      model: 'm',
      date: new Date('2026-01-03T00:00:00')
    })
    expect(text).toContain('2026-01-03')
  })

  it('工作区路径含空格', () => {
    const text = buildSessionContext({
      workingDir: 'D:/my projects/hello world',
      model: 'm',
      date: new Date('2026-06-15T00:00:00')
    })
    expect(text).toContain('Working directory: D:/my projects/hello world')
  })

  it('工作区路径含中文', () => {
    const text = buildSessionContext({
      workingDir: 'D:/项目/诺瓦',
      model: 'm',
      date: new Date('2026-06-15T00:00:00')
    })
    expect(text).toContain('Working directory: D:/项目/诺瓦')
  })

  it('模型 ID 含特殊字符（点 / 斜杠）', () => {
    const text = buildSessionContext({
      workingDir: '/x',
      model: 'deepseek/deepseek-chat-v3',
      date: new Date('2026-06-15T00:00:00')
    })
    expect(text).toContain('Current model: deepseek/deepseek-chat-v3')
  })

  it('纯函数：不读全局状态，相同入参产出相同结果', () => {
    const opts = {
      workingDir: '/stable',
      model: 'stable-model',
      date: new Date('2026-06-15T00:00:00')
    }
    expect(buildSessionContext(opts)).toBe(buildSessionContext(opts))
  })

  it('默认 date 为当前时间（不抛错）', () => {
    const text = buildSessionContext({
      workingDir: '/x',
      model: 'm'
      // 不传 date
    })
    expect(text).toMatch(/Today is \d{4}-\d{2}-\d{2}/)
  })

  it('文本格式稳定：日期/模型/OS/工作区顺序固定，便于缓存前缀匹配', () => {
    const text = buildSessionContext({
      workingDir: '/x',
      model: 'm',
      date: new Date('2026-06-15T00:00:00')
    })
    // 顺序：Today is → Current model → OS → Working directory
    const idxToday = text.indexOf('Today is')
    const idxModel = text.indexOf('Current model')
    const idxOs = text.indexOf('OS:')
    const idxWd = text.indexOf('Working directory')
    expect(idxToday).toBeLessThan(idxModel)
    expect(idxModel).toBeLessThan(idxOs)
    expect(idxOs).toBeLessThan(idxWd)
  })

  it('OS 标签非空（至少给出明确信号）', () => {
    const text = buildSessionContext({
      workingDir: '/x',
      model: 'm',
      date: new Date('2026-06-15T00:00:00')
    })
    // 提取 OS: 后的值，到下一个 '. ' 之前
    const match = text.match(/OS: ([^.]+)\./)
    expect(match).not.toBeNull()
    expect(match![1].trim().length).toBeGreaterThan(0)
  })
})
