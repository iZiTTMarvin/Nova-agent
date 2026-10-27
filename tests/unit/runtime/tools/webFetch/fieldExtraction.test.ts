import { describe, expect, it } from 'vitest'
import {
  ExtractionResultCache,
  currentExtractionReferenceDate,
  extractPageFields,
  parseExtractFields
} from '../../../../../src/runtime/tools/webFetch/extraction'
import type {
  FieldExtractionProvider,
  PageExtraction
} from '../../../../../src/runtime/tools/webFetch/extraction'

function provider(
  answers: Record<string, unknown>,
  options: { maxEstimatedTokens?: number; onRequest?: (page: string) => void } = {}
): FieldExtractionProvider {
  return {
    name: 'current-model',
    cacheKey: 'test-provider',
    maxEstimatedTokens: options.maxEstimatedTokens,
    extract: async request => {
      options.onRequest?.(request.page)
      return { answers }
    }
  }
}

function success(result: PageExtraction) {
  expect('fields' in result).toBe(true)
  if ('error' in result) throw new Error(result.error)
  return result
}

describe('字段定义与类型校验', () => {
  it('解析支持的类型、字段说明和特殊字段名', () => {
    const fields = parseExtractFields(JSON.parse(JSON.stringify({
      price: 'number: Pro monthly price',
      trial_days: 'integer',
      release: 'date',
      wait: 'duration.minutes',
      tags: 'list',
      scores: 'list.number',
      ['__proto__']: 'text',
      constructor: 'text'
    })))
    expect(fields.price).toEqual({ type: 'number', instructions: 'Pro monthly price' })
    expect(fields.trial_days).toEqual({ type: 'number', integer: true })
    expect(fields.wait).toEqual({ type: 'duration', unit: 'minutes' })
    expect(fields.scores).toEqual({ type: 'list', items: 'number' })
    expect(Object.keys(fields)).toContain('__proto__')
  })

  it('非法字段在抓取前即可被拒绝', () => {
    expect(() => parseExtractFields({})).toThrow('1 到 16')
    expect(() => parseExtractFields({ 'bad name': 'number' })).toThrow('字段名')
    expect(() => parseExtractFields({ price: 'money' })).toThrow('不受支持')
    expect(() => parseExtractFields({ price: `number: ${'x'.repeat(600)}` })).toThrow('不能超过 600 字符')
  })

  it('正式值必须同时满足类型、置信度和页面证据', async () => {
    const page = '# Plans\nPro: $1,299.00 per year.\nRelease v5.3.1 ships **Acme  Pro** today.\nNext review: 2026-11-02.'
    const result = success(await extractPageFields(page, parseExtractFields({
      plan: 'text',
      yearly: 'number',
      minor: 'integer',
      review: 'date'
    }), provider({
      plan: { value: 'acme pro', confidence: 0.99 },
      yearly: { value: 1299, confidence: 0.99 },
      minor: { value: 3, confidence: 0.99 },
      review: { value: '2026-11-02', confidence: 0.99 }
    })))

    expect(result.fields.plan).toMatchObject({
      status: 'extracted', value: 'acme pro', evidence: { line: 3 }
    })
    expect(result.fields.yearly).toMatchObject({
      status: 'extracted', value: 1299, evidence: { line: 2, text: 'Pro: $1,299.00 per year.' }
    })
    expect(result.fields.review).toMatchObject({
      status: 'extracted', value: '2026-11-02', evidence: { line: 4 }
    })
    // 版本号中的 3 不能冒充一个已被页面证实的独立整数。
    expect(result.fields.minor).toMatchObject({ status: 'uncertain', guess: 3, notFound: true })
  })

  it('数字证据拒绝标识符和连字符片段，接受正常货币、百分比与空格单位', async () => {
    const invalid = success(await extractPageFields('SKU=AB42CD\nDate 2026-11-02', parseExtractFields({
      sku: 'number', datePart: 'number'
    }), provider({
      sku: { value: 42, confidence: 0.99 },
      datePart: { value: 11, confidence: 0.99 }
    })))
    expect(invalid.fields.sku).toMatchObject({ status: 'uncertain', notFound: true })
    expect(invalid.fields.datePart).toMatchObject({ status: 'uncertain', notFound: true })

    const valid = success(await extractPageFields('Price $42\nDiscount 43%\nWeight 44 kg', parseExtractFields({
      price: 'number', discount: 'number', weight: 'number'
    }), provider({
      price: { value: 42, confidence: 0.99 },
      discount: { value: 43, confidence: 0.99 },
      weight: { value: 44, confidence: 0.99 }
    })))
    expect(valid.fields.price).toMatchObject({ status: 'extracted', evidence: { line: 1 } })
    expect(valid.fields.discount).toMatchObject({ status: 'extracted', evidence: { line: 2 } })
    expect(valid.fields.weight).toMatchObject({ status: 'extracted', evidence: { line: 3 } })
  })

  it('同行普通文本与链接只计一次，真正不同位置的文本才算歧义', async () => {
    const fields = parseExtractFields({ product: 'text' })
    const linked = success(await extractPageFields('Acme [文档](https://example.com)', fields, provider({
      product: { value: 'Acme', confidence: 0.99 }
    })))
    expect(linked.fields.product).toMatchObject({ status: 'extracted', evidence: { line: 1 } })

    const duplicated = success(await extractPageFields('Acme first\nAcme second', fields, provider({
      product: { value: 'Acme', confidence: 0.99 }
    })))
    expect(duplicated.fields.product).toMatchObject({ status: 'uncertain', guess: 'Acme' })

    const overlapping = success(await extractPageFields('banana', fields, provider({
      product: { value: 'ana', confidence: 0.99 }
    })))
    expect(overlapping.fields.product).toMatchObject({ status: 'uncertain', guess: 'ana' })
    expect(overlapping.fields.product).not.toHaveProperty('evidence')
  })

  it('同一数字多处命中时不随意选择来源，也不把它当成已核实字段', async () => {
    const result = success(await extractPageFields('Old plan: 42\nNew plan: 42', parseExtractFields({ price: 'number' }), provider({
      price: { value: 42, confidence: 0.99 }
    })))
    expect(result.fields.price).toMatchObject({ status: 'uncertain', guess: 42 })
    expect(result.fields.price).not.toHaveProperty('evidence')
  })

  it('跨行文本提供真实证据，同行与跨行的重复命中都降级', async () => {
    const fields = parseExtractFields({ product: 'text' })
    const model = provider({ product: { value: 'Acme Pro', confidence: 0.99 } })
    const unique = success(await extractPageFields('Plans\nAcme\nPro', fields, model))
    expect(unique.fields.product).toMatchObject({
      status: 'extracted', evidence: { line: 2, text: 'Acme Pro' }
    })
    for (const page of ['Acme\nPro\nAcme\nPro', 'Acme Pro\nAcme\nPro']) {
      const repeated = success(await extractPageFields(page, fields, model))
      expect(repeated.fields.product).toMatchObject({ status: 'uncertain', guess: 'Acme Pro' })
      expect(repeated.fields.product).not.toHaveProperty('evidence')
    }
  })

  it('中文自然语言数值可核实，分隔符有多种数量级读法时不能确定', async () => {
    const fields = parseExtractFields({ price: 'number' })
    const chinese = success(await extractPageFields('价格20元', fields, provider({
      price: { value: 20, confidence: 0.99 }
    })))
    expect(chinese.fields.price).toMatchObject({ status: 'extracted', value: 20, evidence: { text: '价格20元' } })
    for (const value of [0.005, 0.125]) {
      const decimal = success(await extractPageFields(`Price ${value} USD`, fields, provider({
        price: { value, confidence: 0.99 }
      })))
      expect(decimal.fields.price).toMatchObject({ status: 'extracted', value })
    }
    for (const value of [1.299, 1299]) {
      const ambiguous = success(await extractPageFields('Price 1,299', fields, provider({
        price: { value, confidence: 0.99 }
      })))
      expect(ambiguous.fields.price).toMatchObject({ status: 'uncertain', guess: value })
    }
  })

  it('低置信度、错误类型、非法日期、缺失值和页面外文本都不会成为正式值', async () => {
    const result = success(await extractPageFields('Only real text is here.', parseExtractFields({
      invoice: 'text',
      due: 'date',
      count: 'integer',
      missing: 'text',
      invented: 'text'
    }), provider({
      invoice: { value: 'INV-1', confidence: 0.4 },
      due: { value: '2026-13-45', confidence: 0.99 },
      count: { value: 2.5, confidence: 0.99 },
      missing: { value: null, confidence: 0.99 },
      invented: { value: 'NOT-ON-PAGE', confidence: 0.99 }
    })))
    expect(result.fields.invoice.status).toBe('uncertain')
    expect(result.fields.due.status).toBe('uncertain')
    expect(result.fields.count.status).toBe('uncertain')
    expect(result.fields.missing).toEqual({ status: 'null' })
    expect(result.fields.invented).toMatchObject({ status: 'uncertain', notFound: true })
  })

  it('按 provider 的 token 预算截断并明确标记，不能静默宣称读完整页', async () => {
    let sent = ''
    const result = success(await extractPageFields(
      'alpha beta gamma delta '.repeat(100),
      parseExtractFields({ value: 'text' }),
      provider({ value: { value: null } }, {
        maxEstimatedTokens: 10,
        onRequest: page => { sent = page }
      })
    ))
    expect(result.cut).toBe(true)
    expect(sent.length).toBeLessThan(100)
    expect(sent.length).toBeGreaterThan(0)
  })

  it('调用方取消向外传播，不伪装成普通提取失败', async () => {
    const controller = new AbortController()
    controller.abort()
    const abortingProvider: FieldExtractionProvider = {
      name: 'current-model',
      cacheKey: 'abort',
      extract: async request => {
        request.signal.throwIfAborted()
        return { answers: {} }
      }
    }
    await expect(extractPageFields('page', parseExtractFields({ value: 'text' }), abortingProvider, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('提取结果缓存', () => {
  it('同运行重复请求只执行一次，force 强制重算，失败不进入缓存', async () => {
    const cache = new ExtractionResultCache(2)
    const value = success(await extractPageFields('Price 42', parseExtractFields({ price: 'number' }), provider({ price: { value: 42, confidence: 0.99 } })))
    let calls = 0
    const load = async () => {
      calls++
      await new Promise(resolve => setTimeout(resolve, 5))
      return value
    }
    const [first, second] = await Promise.all([
      cache.getOrLoad('key', 'run:key', false, load),
      cache.getOrLoad('key', 'run:key', false, load)
    ])
    expect(first).toBe(second)
    expect(calls).toBe(1)
    await cache.getOrLoad('key', 'run:key', false, load)
    expect(calls).toBe(1)
    await cache.getOrLoad('key', 'run:force:key', true, load)
    expect(calls).toBe(2)

    let failures = 0
    const failedLoad = async () => {
      failures++
      return { provider: 'current-model' as const, error: 'failed' }
    }
    await cache.getOrLoad('bad', 'run:bad', false, failedLoad)
    await cache.getOrLoad('bad', 'run:bad', false, failedLoad)
    expect(failures).toBe(2)
  })

  it('无 pending key 的独立调用不共享在途请求，但仍复用已完成结果', async () => {
    const cache = new ExtractionResultCache(2)
    const value = success(await extractPageFields('Price 42', parseExtractFields({ price: 'number' }), provider({ price: { value: 42, confidence: 0.99 } })))
    let calls = 0
    const load = async () => {
      calls++
      await new Promise(resolve => setTimeout(resolve, 5))
      return value
    }
    await Promise.all([
      cache.getOrLoad('independent', undefined, false, load),
      cache.getOrLoad('independent', undefined, false, load)
    ])
    expect(calls).toBe(2)
    await cache.getOrLoad('independent', undefined, false, load)
    expect(calls).toBe(2)
  })

  it('较早的普通请求完成后不得覆盖较新的 force 结果', async () => {
    const cache = new ExtractionResultCache(2)
    const base = success(await extractPageFields('Price 42', parseExtractFields({ price: 'number' }), provider({ price: { value: 42, confidence: 0.99 } })))
    const normal = cache.getOrLoad('generation', 'normal', false, async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      return { ...base, cut: false }
    })
    const forced = cache.getOrLoad('generation', 'force', true, async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      return { ...base, cut: true }
    })
    await Promise.all([normal, forced])
    const cached = await cache.getOrLoad('generation', 'reader', false, async () => {
      throw new Error('应当命中缓存')
    })
    expect(cached).toMatchObject({ cut: true })
  })

  it('相对日期使用 UTC 参考日，格式可直接交给 provider', () => {
    expect(currentExtractionReferenceDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
