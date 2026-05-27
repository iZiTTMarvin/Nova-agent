import { describe, it, expect } from 'vitest'
import { extractPartialString, parsePartialToolArgs } from '../../../src/renderer/features/chat/partialJsonArgs'

describe('extractPartialString', () => {
  it('空字符串或缺失 key 返回 undefined', () => {
    expect(extractPartialString('', 'path')).toBeUndefined()
    expect(extractPartialString('{"content":"x"}', 'path')).toBeUndefined()
  })

  it('完整 JSON 提取完整字符串值', () => {
    expect(extractPartialString('{"path":"a.html","content":"hello"}', 'path')).toBe('a.html')
    expect(extractPartialString('{"path":"a.html","content":"hello"}', 'content')).toBe('hello')
  })

  it('半截 path：返回已收部分', () => {
    expect(extractPartialString('{"path":"a.ht', 'path')).toBe('a.ht')
  })

  it('完整 path + 半截 content：两个字段都能提取', () => {
    const partial = '{"path":"a.html","content":"<!DOC'
    expect(extractPartialString(partial, 'path')).toBe('a.html')
    expect(extractPartialString(partial, 'content')).toBe('<!DOC')
  })

  it('content 含 \\n 转义：反转义为真实换行符', () => {
    expect(extractPartialString('{"path":"a.html","content":"line1\\nline2"}', 'content')).toBe('line1\nline2')
  })

  it('content 含转义引号：正确处理 \\"', () => {
    // 完整闭合
    expect(extractPartialString('{"content":"con\\"tent"}', 'content')).toBe('con"tent')
  })

  it('转义引号截断在反斜杠处：返回已收部分', () => {
    // "con\" — 反斜杠吃掉引号，字符串未闭合
    const result = extractPartialString('{"content":"con\\"', 'content')
    // 反斜杠后面有 "，所以被转义为引号，字符串仍未闭合
    // 返回 con" (已反转义)
    expect(result).toBe('con"')
  })

  it('\\uXXXX 完整与不完整', () => {
    // 完整 unicode 转义
    expect(extractPartialString('{"path":"\\u0041BC"}', 'path')).toBe('ABC')
    // 不完整 unicode：只有 3 位 hex，返回已累积部分（空字符串，表示 key 找到但值尚未开始）
    expect(extractPartialString('{"path":"\\u004', 'path')).toBe('')
    // 不完整 unicode 但前面已有累积内容
    expect(extractPartialString('{"path":"hello\\u004', 'path')).toBe('hello')
  })

  it('其他转义：\\\\ \\/ \\r \\t \\b \\f', () => {
    expect(extractPartialString('{"a":"\\\\slash"}', 'a')).toBe('\\slash')
    expect(extractPartialString('{"a":"\\/path"}', 'a')).toBe('/path')
    expect(extractPartialString('{"a":"\\r\\n"}', 'a')).toBe('\r\n')
    expect(extractPartialString('{"a":"\\t"}', 'a')).toBe('\t')
    expect(extractPartialString('{"a":"\\b"}', 'a')).toBe('\b')
    expect(extractPartialString('{"a":"\\f"}', 'a')).toBe('\f')
  })

  it('key 后有空格和冒号也能正确提取', () => {
    expect(extractPartialString('{ "path" : "a.ts" }', 'path')).toBe('a.ts')
  })

  it('key 后没有冒号返回 undefined', () => {
    expect(extractPartialString('{"path" "a.ts"}', 'path')).toBeUndefined()
  })

  it('key 后不是字符串值返回 undefined', () => {
    expect(extractPartialString('{"count":42}', 'count')).toBeUndefined()
    expect(extractPartialString('{"flag":true}', 'flag')).toBeUndefined()
  })

  it('大文件压测：1000 次累加调用', () => {
    // 模拟 1000 个 chunk 累积到完整 JSON
    const chunks: string[] = []
    const targetContent = 'line1\nline2\nline3'
    const fullJson = `{"path":"big.html","content":"${targetContent.replace(/\n/g, '\\n')}"}`
    // 分成小片段
    const chunkSize = Math.max(1, Math.floor(fullJson.length / 1000))
    for (let i = 0; i < fullJson.length; i += chunkSize) {
      chunks.push(fullJson.slice(i, i + chunkSize))
    }

    let accumulated = ''
    let lastPath: string | undefined
    let lastContent: string | undefined
    for (const chunk of chunks) {
      accumulated += chunk
      lastPath = extractPartialString(accumulated, 'path')
      lastContent = extractPartialString(accumulated, 'content')
      // 每次都不抛错
    }

    // 最终应提取完整值
    expect(lastPath).toBe('big.html')
    expect(lastContent).toBe(targetContent)
  })
})

describe('parsePartialToolArgs', () => {
  it('空 raw 返回空对象', () => {
    expect(parsePartialToolArgs('write', '')).toEqual({})
  })

  it('write 工具提取 path 和 content', () => {
    const result = parsePartialToolArgs('write', '{"path":"index.html","content":"hello"}')
    expect(result).toEqual({ path: 'index.html', content: 'hello' })
  })

  it('write 半截参数：只提取已收部分', () => {
    const result = parsePartialToolArgs('write', '{"path":"ind')
    expect(result).toEqual({ path: 'ind' })
  })

  it('edit 工具提取 path、old、new', () => {
    const result = parsePartialToolArgs('edit', '{"path":"a.ts","old":"foo","new":"bar"}')
    expect(result).toEqual({ path: 'a.ts', old: 'foo', new: 'bar' })
  })

  it('edit 半截参数', () => {
    const result = parsePartialToolArgs('edit', '{"path":"a.ts","old":"f')
    expect(result).toEqual({ path: 'a.ts', old: 'f' })
  })

  it('bash 工具提取 command', () => {
    const result = parsePartialToolArgs('bash', '{"command":"npm test"}')
    expect(result).toEqual({ command: 'npm test' })
  })

  it('bash 半截参数', () => {
    const result = parsePartialToolArgs('bash', '{"command":"npm')
    expect(result).toEqual({ command: 'npm' })
  })

  it('未识别工具返回空对象', () => {
    const result = parsePartialToolArgs('read', '{"path":"a.ts"}')
    expect(result).toEqual({})
  })

  it('toolName 为空字符串返回空对象', () => {
    const result = parsePartialToolArgs('', '{"path":"a.ts"}')
    expect(result).toEqual({})
  })
})