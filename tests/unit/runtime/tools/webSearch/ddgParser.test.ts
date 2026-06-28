/**
 * DuckDuckGo HTML 解析器单元测试
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeDdgRedirectUrl, parseDdgHtml } from '../../../../../src/runtime/tools/webSearch/scraper/ddgParser'

const fixturePath = join(__dirname, '../../../../fixtures/webSearch/ddg.html')

describe('decodeDdgRedirectUrl', () => {
  it('从 uddg 参数解出真实 URL', () => {
    const href = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com'
    expect(decodeDdgRedirectUrl(href)).toBe('https://example.com')
  })
})

describe('parseDdgHtml', () => {
  it('从 fixture 解析 title/url/snippet', () => {
    const html = readFileSync(fixturePath, 'utf-8')
    const sources = parseDdgHtml(html, 5)

    expect(sources).toHaveLength(2)
    expect(sources[0].title).toBe('Example Site')
    expect(sources[0].url).toBe('https://example.com')
    expect(sources[0].snippet).toContain('DuckDuckGo')
    expect(sources[1].title).toBe('React Official')
    expect(sources[1].url).toBe('https://react.dev')
  })

  it('跳过广告结果', () => {
    const html = readFileSync(fixturePath, 'utf-8')
    const sources = parseDdgHtml(html, 10)
    expect(sources.every(s => !s.url.includes('ad.example.com'))).toBe(true)
  })

  it('畸形 HTML 返回空数组', () => {
    expect(parseDdgHtml('<html><body>empty</body></html>', 5)).toEqual([])
  })

  it('空字符串返回空数组', () => {
    expect(parseDdgHtml('', 5)).toEqual([])
  })
})
