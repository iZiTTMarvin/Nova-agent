import { MEMORY_LITERAL_BONUS, MEMORY_QUERY_MAX_TERMS } from '../memoryConfig'

const CJK = '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]'
const parts = (text: string): string[] => text.normalize('NFKC').match(new RegExp(`${CJK}+|[\\p{Script=Latin}\\p{N}]+(?:[._-][\\p{Script=Latin}\\p{N}]+)*`, 'gu')) ?? []
const isCjk = (text: string): boolean => new RegExp(`^${CJK}+$`, 'u').test(text)

export function buildIndexTerms(text: string): string {
  const terms: string[] = []
  for (const part of parts(text)) {
    if (isCjk(part)) {
      const chars = Array.from(part)
      terms.push(...chars)
      for (let i = 0; i + 1 < chars.length; i++) terms.push(chars[i] + chars[i + 1])
    } else {
      terms.push(part.toLowerCase())
      terms.push(...part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[._\s-]+/))
    }
  }
  return [...new Set(terms)].join(' ')
}

export function buildQueryTerms(text: string): string[] {
  const singleHan = /^\p{Script=Han}$/u.test(text.normalize('NFKC').trim())
  return buildIndexTerms(text).split(' ').filter(term => term && (singleHan || !isCjk(term) || Array.from(term).length > 1)).slice(0, MEMORY_QUERY_MAX_TERMS)
}

const quote = (term: string): string => `"${term.replace(/"/g, '""')}"`
export function buildMemoryIndexQuery(text: string): { terms: string | null; literal: string | null } {
  const terms = buildQueryTerms(text)
  const literal = [...new Set(parts(text).map(part => part.toLowerCase()).filter(part => Array.from(part).length >= 3))]
  return { terms: terms.length ? terms.map(quote).join(' OR ') : null, literal: literal.length ? literal.map(quote).join(' OR ') : null }
}

export interface LexicalHit { id: string; score: number }
export function mergeLexicalHits(terms: readonly LexicalHit[], literal: readonly LexicalHit[], normalizers?: { terms: number; literal: number }, literalBonus = MEMORY_LITERAL_BONUS): LexicalHit[] {
  const scores = new Map<string, number>()
  for (const [hits, bonus, normalizer] of [[terms, 0, normalizers?.terms], [literal, literalBonus, normalizers?.literal]] as const) {
    const top = normalizer ?? Math.max(0, ...hits.map(hit => hit.score))
    for (const hit of hits) scores.set(hit.id, Math.max(scores.get(hit.id) ?? 0, (top > 0 ? hit.score / top : 0) + bonus))
  }
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}
