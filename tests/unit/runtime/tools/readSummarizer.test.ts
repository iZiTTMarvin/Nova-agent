/**
 * readSummarizer 单元测试
 */
import { describe, it, expect } from 'vitest'
import {
  summarizeStructure,
  isSummarizableExtension,
  MIN_SUMMARY_LINES,
} from '../../../../src/runtime/tools/readSummarizer'

/** 生成含 N 个大函数（每个约 20 行函数体）的 TS 测试文件，总行数约 N*22 */
function generateLargeTsFile(fnCount: number, bodyLines = 15): string {
  const header = [
    "import { util } from './util'",
    "import type { Config } from './types'",
    '',
  ].join('\n')

  const functions: string[] = []
  for (let i = 0; i < fnCount; i++) {
    functions.push(`export function compute${i}(input: number): number {`)
    for (let j = 0; j < bodyLines; j++) {
      functions.push(`  const step${j} = input + ${i} + ${j}`)
    }
    functions.push(`  return step${bodyLines - 1}`)
    functions.push(`}`)
    functions.push('')
  }

  const tail = [
    'export class ResultBuilder {',
    '  build(): string { return "ok" }',
    '}',
    '',
    'export { compute0 as defaultHelper }',
    'export default ResultBuilder',
  ].join('\n')

  return `${header}${functions.join('\n')}${tail}`
}

describe('readSummarizer', () => {
  it('2000 行 TS 文件摘要字节数 < 原文 15%', () => {
    // ~90 个函数 × ~20 行 ≈ 2000 行；大函数体折叠后摘要应远小于原文
    const original = generateLargeTsFile(90, 15)
    const originalLines = original.split('\n').length
    expect(originalLines).toBeGreaterThanOrEqual(MIN_SUMMARY_LINES)

    const summary = summarizeStructure('module.ts', original)
    expect(summary).not.toBeNull()

    const ratio = Buffer.byteLength(summary!, 'utf8') / Buffer.byteLength(original, 'utf8')
    expect(ratio).toBeLessThan(0.15)
  })

  it('摘要保留所有 exported 函数/类签名', () => {
    const big = generateLargeTsFile(420, 3)
    const result = summarizeStructure('big.ts', big)!
    expect(result).toContain('export function compute0')
    expect(result).toContain('export function compute419')
    expect(result).toContain('export class ResultBuilder')
    expect(result).toContain('{folded}:')
    expect(result).toContain('--- exports (last 20 lines) ---')
    expect(result).toContain('import { util }')
  })

  it('非支持扩展名返回 null', () => {
    const content = 'x\n'.repeat(500)
    expect(summarizeStructure('file.md', content)).toBeNull()
    expect(summarizeStructure('file.txt', content)).toBeNull()
    expect(isSummarizableExtension('.md')).toBe(false)
  })

  it('行数不足 MIN_SUMMARY_LINES 时返回 null', () => {
    const small = generateLargeTsFile(10) // ~60 行
    expect(summarizeStructure('small.ts', small)).toBeNull()
  })

  it('Python 文件可生成摘要', () => {
    const lines: string[] = ['import os', '']
    for (let i = 0; i < 420; i++) {
      lines.push(`def handler_${i}(x):`, `    return x + ${i}`, '')
    }
    lines.push('export = handler_0  # noqa')
    const content = lines.join('\n')
    const summary = summarizeStructure('app.py', content)
    expect(summary).not.toBeNull()
    expect(summary).toContain('def handler_0')
    expect(summary).toContain('{folded}:')
  })
})
