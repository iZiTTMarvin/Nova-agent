/**
 * formatForLLM 单元测试
 */
import { describe, expect, it } from 'vitest'
import { formatForLLM } from '../../../../../src/runtime/tools/webSearch/formatters'

describe('formatForLLM', () => {
  it('包含 answer 和 sources 时格式正确', () => {
    const response = {
      provider: 'tavily' as const,
      answer: 'React 19 is the latest version.',
      sources: [
        { title: 'React 19', url: 'https://react.dev', snippet: 'Official release notes.' }
      ]
    }
    const output = formatForLLM(response)
    expect(output).toContain('React 19 is the latest version.')
    expect(output).toContain('[1] React 19')
    expect(output).toContain('https://react.dev')
  })

  it('无 answer 时只渲染 sources', () => {
    const response = {
      provider: 'tavily' as const,
      sources: [{ title: 'X', url: 'https://x.com', snippet: 'Short.' }]
    }
    const output = formatForLLM(response)
    expect(output).not.toContain('undefined')
    expect(output).toContain('## Sources')
  })

  it('长 snippet 截断到 240 字符', () => {
    const longSnippet = 'a'.repeat(500)
    const response = {
      provider: 'tavily' as const,
      sources: [{ title: 'X', url: 'https://x.com', snippet: longSnippet }]
    }
    const output = formatForLLM(response)
    const snippetLine = output.split('\n').find(l => l.includes('…'))
    expect(snippetLine).toBeTruthy()
    expect(snippetLine!.trim().length).toBeLessThanOrEqual(241)
  })
})
