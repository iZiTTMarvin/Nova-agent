import { describe, expect, it } from 'vitest'
import {
  extractJson,
  extractJsonCandidates
} from '../../../../../src/runtime/workflow/host/jsonExtract'

describe('extractJsonCandidates', () => {
  it('纯净 JSON 整段解析', () => {
    expect(extractJsonCandidates('{"a":1}')).toEqual([{ a: 1 }])
  })

  it('围栏块解析（json 标记与无标记均可）', () => {
    expect(extractJsonCandidates('```json\n{"a":1}\n```')).toEqual([{ a: 1 }])
    expect(extractJsonCandidates('```\n{"a":1}\n```')).toEqual([{ a: 1 }])
  })

  it('散文 + 围栏：散文被跳过，围栏内容命中', () => {
    const text = '好的，基于以上分析给出方案：\n```json\n{"alternatives":[]}\n```\n以上供参考。'
    expect(extractJsonCandidates(text)).toEqual([{ alternatives: [] }])
  })

  it('多个围栏时全部产出，调用方可按 schema 挑选', () => {
    const text = [
      '先看个例子：```json\n{"example":true}\n```',
      '真正的结果是：```json\n{"ok":"right"}\n```'
    ].join('\n')
    const candidates = extractJsonCandidates(text)
    expect(candidates).toContainEqual({ example: true })
    expect(candidates).toContainEqual({ ok: 'right' })
    // 围栏顺序即候选顺序，先出现者优先
    expect(candidates[0]).toEqual({ example: true })
  })

  it('无围栏时回退平衡大括号扫描', () => {
    const text = '分析结论如下 {"ok":1,"nested":{"x":"y"} } 希望对你有帮助'
    expect(extractJsonCandidates(text)).toContainEqual({ ok: 1, nested: { x: 'y' } })
  })

  it('多个顶层对象各自成为候选', () => {
    const candidates = extractJsonCandidates('{"a":1} 然后是 {"b":2}')
    expect(candidates).toContainEqual({ a: 1 })
    expect(candidates).toContainEqual({ b: 2 })
  })

  it('字符串内的括号不干扰配对', () => {
    const text = '{"json": "{\\"not\\": \\"an object\\"}", "ok": true}'
    expect(extractJsonCandidates(text)).toEqual([
      { json: '{"not": "an object"}', ok: true }
    ])
  })

  it('相同原文候选去重', () => {
    // 围栏内容与其平衡切片是同一原文，只保留一次
    const candidates = extractJsonCandidates('```json\n{"a":1}\n```')
    expect(candidates).toHaveLength(1)
  })

  it('完全不是 JSON 时返回空数组，extractJson 返回 null', () => {
    expect(extractJsonCandidates('这不是 JSON')).toEqual([])
    expect(extractJson('这不是 JSON')).toBeNull()
  })

  it('括号不闭合时返回空数组', () => {
    expect(extractJsonCandidates('{"a": 1, "b": {')).toEqual([])
  })

  it('围栏内是非法 JSON 时继续尝试后续候选', () => {
    const text = '```json\n{bad json}\n```\n然后是 {"ok":true}'
    expect(extractJsonCandidates(text)).toContainEqual({ ok: true })
  })
})
