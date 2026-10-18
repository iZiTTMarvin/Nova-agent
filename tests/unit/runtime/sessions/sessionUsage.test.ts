import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionStore } from '../../../../src/runtime/sessions/SessionStore'
import { resetSessionIndexHostForTests } from '../../../../src/runtime/sessions/SessionIndexHost'
import { normalizeUsage } from '../../../../src/runtime/model/usage'
import { projectSessionUsage } from '../../../../src/shared/session/usage'
import * as atomicFile from '../../../../src/runtime/storage/atomicFile'

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-usage-')) })
afterEach(() => {
  vi.restoreAllMocks()
  resetSessionIndexHostForTests()
  fs.rmSync(root, { recursive: true, force: true })
})
const usage = (cached: number) => normalizeUsage({ prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: cached } })!

describe('会话用量持久化', () => {
  it('新实例恢复全部模型累计，后续用量继续累计，其他会话和旧会话保持未知', () => {
    const store = new SessionStore(root)
    const a = store.create('/workspace')
    const b = store.create('/workspace')
    expect(store.loadUsage(a.id)).toBeNull()
    store.recordUsage(a.id, usage(800), 'openai')
    store.recordUsage(a.id, normalizeUsage({ input_tokens: 1000, cache_read_input_tokens: 7000, cache_creation_input_tokens: 2000, output_tokens: 500 })!, 'anthropic')
    const restarted = new SessionStore(root)
    const snapshot = restarted.recordUsage(a.id, usage(200), 'openai')
    expect(snapshot.revision).toBe(3)
    const projected = projectSessionUsage(snapshot)
    expect(projected.sessionUsage).toMatchObject({
      totalPromptTokens: 10000, totalCacheWriteTokens: 2000, totalCachedTokens: 8000,
      totalOutputTokens: 700, hitRate: 8000 / 12000, lastRoundHitRate: 0.2,
      estimatedSavedInputTokens: 8000,
      cacheCountCoverage: { reportedPositive: 3, reportedZero: 0, unreported: 0 }
    })
    expect(projected.sessionUsage).not.toHaveProperty('totalCacheMissTokens')
    expect(projected.sessionUsageByProfile.openai).toMatchObject({ totalPromptTokens: 2000, hitRate: 0.5 })
    expect(projected.sessionUsageByProfile.anthropic.hitRate).toBe(0.7)
    expect(restarted.loadUsage(a.id)).toEqual(snapshot)
    expect(restarted.loadUsage(b.id)).toBeNull()
  })

  it('持久保留零命中、未报告的区别及可选未命中计数', () => {
    const store = new SessionStore(root)
    const { id } = store.create('/workspace')
    store.recordUsage(id, usage(1000), 'openai')
    store.recordUsage(id, usage(0), 'openai')
    store.recordUsage(id, normalizeUsage({ prompt_tokens: 1000, completion_tokens: 10 })!, 'openai')
    store.recordUsage(id, normalizeUsage({ prompt_tokens: 2000, prompt_cache_hit_tokens: 1500, prompt_cache_miss_tokens: 500, completion_tokens: 100 })!, 'deepseek')
    const projected = projectSessionUsage(new SessionStore(root).loadUsage(id))
    expect(projected.sessionUsage).toMatchObject({ hitRate: 0.5, totalCacheMissTokens: 500,
      cacheCountCoverage: { reportedPositive: 2, reportedZero: 1, unreported: 1 } })
    expect(projected.sessionUsageByProfile.deepseek.hitRate).toBe(0.75)
  })

  it.each(['{broken', '{"version":2}', '{"version":1,"sessionId":"other"}'])('损坏或未知版本不清零覆盖：%s', raw => {
    const store = new SessionStore(root)
    const { id } = store.create('/workspace')
    const file = path.join(store.getSessionsDir(), id, 'usage.json')
    fs.writeFileSync(file, raw)
    expect(() => store.loadUsage(id)).toThrow()
    expect(() => store.recordUsage(id, usage(800), 'openai')).toThrow()
    expect(fs.readFileSync(file, 'utf8')).toBe(raw)
  })

  it('写入失败保留上次提交；不存在或非法会话不会生成目录', () => {
    const store = new SessionStore(root)
    const { id } = store.create('/workspace')
    const first = store.recordUsage(id, usage(800), 'openai')
    const spy = vi.spyOn(atomicFile, 'atomicWriteFileSync').mockImplementation(() => { throw new Error('disk full') })
    expect(() => store.recordUsage(id, usage(200), 'openai')).toThrow('disk full')
    spy.mockRestore()
    expect(new SessionStore(root).loadUsage(id)).toEqual(first)
    expect(() => store.recordUsage('missing', usage(800), 'openai')).toThrow()
    expect(() => store.loadUsage('../outside')).toThrow()
    expect(fs.existsSync(path.join(store.getSessionsDir(), 'missing'))).toBe(false)
  })
})
