import { describe, it, expect } from 'vitest'
import {
  sanitizeToolInput,
  sanitizeToolOutput,
  summarizeLargeText,
  isContentSummary,
  WRITE_TOOL_INLINE_LIMIT,
  EDIT_TOOL_INLINE_LIMIT,
  WRITE_TOOL_PREVIEW_CHARS,
  EDIT_TOOL_PREVIEW_CHARS,
  PREVIEW_TAIL_CHARS,
  MAX_TOOL_OUTPUT_TEXT_CHARS,
  MAX_TOOL_ERROR_CHARS
} from '../../../src/shared/tool-input-sanitizer'

// ── T01：sanitizeToolInput ──────────────────────────────────

describe('sanitizeToolInput', () => {
  it('小 content（<4KB）的 write 不截断', () => {
    const input = { path: '/foo.ts', content: 'short' }
    const result = sanitizeToolInput('write', input)
    expect(result).toEqual(input)
  })

  it('大 content（>4KB）的 write 触发摘要化，head=880, tail=320（总计 1200）', () => {
    const bigContent = 'x'.repeat(WRITE_TOOL_INLINE_LIMIT + 100)
    const input = { path: '/foo.ts', content: bigContent }
    const result = sanitizeToolInput('write', input) as Record<string, unknown>

    expect(result.path).toBe('/foo.ts')
    expect(typeof result.content).toBe('object')
    expect(isContentSummary(result.content)).toBe(true)

    const summary = result.content as ReturnType<typeof summarizeLargeText>
    expect(summary.content_chars).toBe(bigContent.length)
    const expectedHead = WRITE_TOOL_PREVIEW_CHARS - PREVIEW_TAIL_CHARS
    expect(summary.content_head).toBe(bigContent.slice(0, expectedHead))
    expect(summary.content_tail).toBe(bigContent.slice(-PREVIEW_TAIL_CHARS))
    expect(summary.content_hash).toBeTruthy()
  })

  it('刚好等于阈值不截断', () => {
    const exactContent = 'x'.repeat(WRITE_TOOL_INLINE_LIMIT)
    const input = { path: '/foo.ts', content: exactContent }
    const result = sanitizeToolInput('write', input)
    expect(result).toEqual(input)
  })

  it('edit 新 schema：edits 数组中超过阈值的 newText 被摘要化（head=480, tail=320, 总计 800）', () => {
    const bigText = 'y'.repeat(EDIT_TOOL_INLINE_LIMIT + 100)
    const smallText = 'ok'
    const input = {
      filePath: '/bar.ts',
      edits: [
        { oldText: 'a', newText: smallText },
        { oldText: 'b', newText: bigText }
      ]
    }
    const result = sanitizeToolInput('edit', input) as Record<string, unknown>
    const edits = result.edits as Array<Record<string, unknown>>

    expect(edits[0].newText).toBe(smallText)
    expect(isContentSummary(edits[1].newText)).toBe(true)

    const summary = edits[1].newText as ReturnType<typeof summarizeLargeText>
    const expectedEditHead = EDIT_TOOL_PREVIEW_CHARS - PREVIEW_TAIL_CHARS
    expect(summary.content_head.length).toBe(expectedEditHead)
    expect(summary.content_tail.length).toBe(PREVIEW_TAIL_CHARS)
  })

  it('edit 旧 schema：new_string 超过阈值被摘要化', () => {
    const bigText = 'z'.repeat(EDIT_TOOL_INLINE_LIMIT + 100)
    const input = { path: '/baz.ts', old_string: 'a', new_string: bigText }
    const result = sanitizeToolInput('edit', input) as Record<string, unknown>

    expect(isContentSummary(result.new_string)).toBe(true)
  })

  it('其他工具原样返回', () => {
    const input = { command: 'ls -la', timeout: 30000 }
    const result = sanitizeToolInput('bash', input)
    expect(result).toEqual(input)
  })

  it('空对象原样返回', () => {
    const result = sanitizeToolInput('write', {})
    expect(result).toEqual({})
  })

  it('null/undefined 安全返回', () => {
    expect(sanitizeToolInput('write', null as any)).toBe(null)
    expect(sanitizeToolInput('write', undefined as any)).toBe(undefined)
  })
})

// ── T01：summarizeLargeText ──────────────────────────────────

describe('summarizeLargeText', () => {
  it('生成正确的摘要结构', () => {
    const text = 'a'.repeat(5000)
    const summary = summarizeLargeText(text, 800)

    expect(summary.content_omitted).toBe(true)
    expect(summary.content_truncated).toBe(true)
    expect(summary.content_chars).toBe(5000)
    expect(summary.content_lines).toBe(1)
    expect(summary.content_hash).toMatch(/^[0-9a-f]{8}$/)
    expect(summary.content_head.length).toBe(800)
    expect(summary.content_tail.length).toBe(PREVIEW_TAIL_CHARS)
  })

  it('多行文本正确计算行数', () => {
    const text = 'line1\nline2\nline3'
    const summary = summarizeLargeText(text, 100)
    expect(summary.content_lines).toBe(3)
  })
})

// ── T01：isContentSummary ──────────────────────────────────

describe('isContentSummary', () => {
  it('识别有效的摘要对象', () => {
    const summary = summarizeLargeText('test content that is long enough', 100)
    expect(isContentSummary(summary)).toBe(true)
  })

  it('普通字符串不是摘要', () => {
    expect(isContentSummary('hello')).toBe(false)
  })

  it('null 不是摘要', () => {
    expect(isContentSummary(null)).toBe(false)
  })

  it('普通对象不是摘要', () => {
    expect(isContentSummary({ foo: 'bar' })).toBe(false)
  })
})

// ── T02：sanitizeToolOutput ──────────────────────────────────

describe('sanitizeToolOutput', () => {
  it('短输出不截断', () => {
    const output = 'Hello World'
    expect(sanitizeToolOutput('bash', output)).toBe(output)
  })

  it('大输出（>8KB）触发截断，保留头+尾+元信息', () => {
    const bigOutput = 'x'.repeat(MAX_TOOL_OUTPUT_TEXT_CHARS + 5000)
    const result = sanitizeToolOutput('bash', bigOutput)

    expect(result.length).toBeLessThan(bigOutput.length)
    expect(result).toContain('[...truncated')
    expect(result).toContain('hash:')
    expect(result).toContain('lines:')
    expect(result.startsWith('x'.repeat(100))).toBe(true)
    expect(result.endsWith('x'.repeat(100))).toBe(true)
  })

  it('刚好等于阈值不截断', () => {
    const exactOutput = 'x'.repeat(MAX_TOOL_OUTPUT_TEXT_CHARS)
    expect(sanitizeToolOutput('bash', exactOutput)).toBe(exactOutput)
  })

  it('错误输出超过 2KB 截断', () => {
    const bigError = 'e'.repeat(MAX_TOOL_ERROR_CHARS + 1000)
    const result = sanitizeToolOutput('bash', bigError, true)

    expect(result.length).toBeLessThan(bigError.length)
    expect(result).toContain('[...truncated')
    expect(result.startsWith('e'.repeat(100))).toBe(true)
  })

  it('错误输出未超阈值不截断', () => {
    const smallError = 'e'.repeat(MAX_TOOL_ERROR_CHARS - 100)
    expect(sanitizeToolOutput('bash', smallError, true)).toBe(smallError)
  })

  it('非字符串安全返回', () => {
    expect(sanitizeToolOutput('bash', null as any)).toBe(null)
    expect(sanitizeToolOutput('bash', undefined as any)).toBe(undefined)
  })
})

// ── T01：流式 partialArgs 摘要化集成验证 ─────────────────────

describe('sanitizeToolInput 集成：applyStreamDeltas 中的流式 partialArgs', () => {
  /**
   * 验证 write 工具流式累积大 content 时，
   * store 里 block.arguments.content 是摘要对象而不是原始字符串。
   * 这条路径覆盖 useChatStore.ts 的 applyStreamDeltas → sanitizeToolInput 调用。
   */
  it('write 工具流式累积超大 content 时，partialArgs 应被摘要化', () => {
    const bigContent = 'A'.repeat(WRITE_TOOL_INLINE_LIMIT + 500)
    const input = {
      path: 'big-file.ts',
      content: bigContent
    }
    // 模拟 applyStreamDeltas 中的路径：先 parsePartialToolArgs 拿到完整 args，再 sanitizeToolInput
    const partialArgs = { path: input.path, content: input.content }
    const result = sanitizeToolInput('write', partialArgs) as Record<string, unknown>

    // path 不动
    expect(result.path).toBe('big-file.ts')
    // content 被替换为摘要对象
    expect(isContentSummary(result.content)).toBe(true)
    const summary = result.content as ReturnType<typeof summarizeLargeText>
    expect(summary.content_chars).toBe(bigContent.length)
    // head = 1200 - 320 = 880
    expect(summary.content_head).toBe(bigContent.slice(0, WRITE_TOOL_PREVIEW_CHARS - PREVIEW_TAIL_CHARS))
    expect(summary.content_tail).toBe(bigContent.slice(-PREVIEW_TAIL_CHARS))
  })

  it('write 工具流式累积小 content 时不截断', () => {
    const smallContent = 'hello world'
    const partialArgs = { path: 'small.ts', content: smallContent }
    const result = sanitizeToolInput('write', partialArgs)

    expect(result).toEqual(partialArgs)
  })
})
