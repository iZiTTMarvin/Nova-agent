/**
 * Provider 链 fallback 逻辑单元测试
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getAvailableProviders,
  SEARCH_PROVIDER_ORDER
} from '../../../../../src/runtime/tools/webSearch/providers/index'
import { resetDdgCooldown } from '../../../../../src/runtime/tools/webSearch/providers/duckduckgo'

describe('getAvailableProviders', () => {
  beforeEach(() => {
    resetDdgCooldown()
    process.env.TAVILY_API_KEY = 'test-key'
  })

  afterEach(() => {
    delete process.env.TAVILY_API_KEY
    resetDdgCooldown()
  })

  it('只返回 isAvailable=true 的 provider', () => {
    const providers = getAvailableProviders()
    for (const p of providers) {
      expect(p.isAvailable()).toBe(true)
    }
  })

  it('无 Tavily API key 时仍返回 bing 与 duckduckgo', () => {
    delete process.env.TAVILY_API_KEY
    const names = getAvailableProviders().map(p => p.name)
    expect(names).toEqual(['bing', 'duckduckgo'])
  })

  it('有 Tavily API key 时返回全部三个 provider', () => {
    const names = getAvailableProviders().map(p => p.name)
    expect(names).toEqual(['bing', 'duckduckgo', 'tavily'])
  })

  it('返回顺序遵循 SEARCH_PROVIDER_ORDER', () => {
    const providers = getAvailableProviders()
    const names = providers.map(p => p.name)
    const expected = SEARCH_PROVIDER_ORDER.filter(name =>
      providers.some(p => p.name === name)
    )
    expect(names).toEqual(expected)
  })

  it('SEARCH_PROVIDER_ORDER 固定为 bing → duckduckgo → tavily', () => {
    expect(SEARCH_PROVIDER_ORDER).toEqual(['bing', 'duckduckgo', 'tavily'])
  })
})
