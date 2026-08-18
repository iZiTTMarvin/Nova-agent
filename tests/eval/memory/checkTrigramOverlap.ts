/**
 * 数据集词表自检工具（node --experimental-strip-types 运行，不参与测试门禁）：
 * 列出 query 与期望内容零 trigram 交集的用例。trigram 检索的词元下限是 3 字符，
 * 新增用例前先跑本工具确认期望内容可被查询词元命中。
 */
import { EVAL_CASES, SEED_SPECS } from './evalCases.ts'
import { sanitizeTrigramQuery } from '../../../src/runtime/memory/FtsQueryBuilder.ts'

function trigrams(text: string): Set<string> {
  const cleaned = sanitizeTrigramQuery(text)
  const grams = new Set<string>()
  for (let i = 0; i + 3 <= cleaned.length; i += 1) {
    grams.add(cleaned.slice(i, i + 3))
  }
  return grams
}

const contentById = new Map(SEED_SPECS.map((s) => [s.id, s.content]))

let bad = 0
for (const c of EVAL_CASES) {
  const q = trigrams(c.query)
  for (const expected of c.expectedMemoryIds) {
    const content = contentById.get(expected)
    if (!content) {
      console.error(`MISSING SEED: ${expected} (case ${c.id})`)
      bad += 1
      continue
    }
    const g = trigrams(content)
    let shared = 0
    for (const t of q) {
      if (g.has(t)) shared += 1
    }
    if (shared === 0) {
      console.log(`NO-OVERLAP ${c.id} query="${c.query}" expected=${expected} content="${content}"`)
      bad += 1
    }
  }
}
console.log(bad === 0 ? 'all cases share >=1 trigram with expected content' : `${bad} problem(s)`)
