/**
 * Bing HTML 解析器单元测试
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeBingRedirectUrl, parseBingHtml } from '../../../../../src/runtime/tools/webSearch/scraper/bingParser'

const fixturePath = join(__dirname, '../../../../fixtures/webSearch/bing.html')

describe('decodeBingRedirectUrl', () => {
  it('解码 bing.com/ck/a 重定向 URL', () => {
    const encoded = 'https://www.bing.com/ck/a?&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbQ'
    expect(decodeBingRedirectUrl(encoded)).toBe('https://example.com')
  })

  it('非重定向 URL 原样返回', () => {
    expect(decodeBingRedirectUrl('https://react.dev')).toBe('https://react.dev')
  })
})

describe('parseBingHtml', () => {
  it('从 fixture 解析 title/url/snippet', () => {
    const html = readFileSync(fixturePath, 'utf-8')
    const sources = parseBingHtml(html, 5)

    expect(sources.length).toBeGreaterThanOrEqual(2)
    expect(sources[0].title).toBe('Example Site')
    expect(sources[0].url).toBe('https://example.com')
    expect(sources[0].snippet).toContain('example snippet')
    expect(sources[1].title).toBe('React Official')
    expect(sources[1].url).toBe('https://react.dev')
  })

  it('尊重 maxResults 上限', () => {
    const html = readFileSync(fixturePath, 'utf-8')
    expect(parseBingHtml(html, 1)).toHaveLength(1)
  })

  it('畸形 HTML 返回空数组', () => {
    expect(parseBingHtml('<html><body>no results</body></html>', 5)).toEqual([])
  })

  it('空字符串返回空数组', () => {
    expect(parseBingHtml('', 5)).toEqual([])
  })
})
