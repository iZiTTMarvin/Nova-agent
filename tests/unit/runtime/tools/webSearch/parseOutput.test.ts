/**
 * parseWebSearchOutput 单元测试
 */
import { describe, expect, it } from 'vitest'
import { formatForLLM } from '../../../../../src/runtime/tools/webSearch/formatters'
import { parseWebSearchOutput } from '../../../../../src/shared/webSearch/parseOutput'

describe('parseWebSearchOutput', () => {
  it('从 formatForLLM 输出解析 answer 与 sources', () => {
    const output = formatForLLM({
      provider: 'tavily',
      answer: 'React 19 is latest.',
      sources: [
        { title: 'React Docs', url: 'https://react.dev', snippet: 'Release notes.' },
        { title: 'Blog', url: 'https://react.dev/blog', snippet: 'Blog post.' }
      ]
    })

    const parsed = parseWebSearchOutput(output)
    expect(parsed.answer).toBe('React 19 is latest.')
    expect(parsed.sources).toHaveLength(2)
    expect(parsed.sources[0].title).toBe('React Docs')
    expect(parsed.sources[0].url).toBe('https://react.dev')
    expect(parsed.sources[1].url).toBe('https://react.dev/blog')
  })

  it('无 ## Sources 时 sources 为空', () => {
    const parsed = parseWebSearchOutput('仅有一段回答文本')
    expect(parsed.answer).toBe('仅有一段回答文本')
    expect(parsed.sources).toEqual([])
  })
})
