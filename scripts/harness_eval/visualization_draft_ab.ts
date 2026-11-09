import { mkdir, writeFile } from 'node:fs/promises'
import { cpus, totalmem } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { estimateTextTokens } from '../../src/shared/model/tokenEstimate'
import { compileVisualizationDraft } from '../../src/shared/visualization/draft'
import { validateVisualizationHtml } from '../../src/runtime/visualizations/validateVisualizationHtml'
import { VISUALIZATION_EVAL_CORPUS } from '../../docs/Local_Docs/评估报告/2026-11-04-学习声明式可视化/corpus'

const outputArg = process.argv.indexOf('--output-dir')
if (outputArg >= 0 && !process.argv[outputArg + 1]) throw new Error('--output-dir 需要目录路径')
const OUTPUT_DIR = path.resolve(outputArg >= 0 ? process.argv[outputArg + 1] : 'docs/Local_Docs/评估报告/2026-11-04-学习声明式可视化')

function percentile(values: readonly number[], ratio: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

async function measure(operation: () => void | Promise<void>, iterations: number): Promise<{ p50: number; p95: number; max: number }> {
  for (let index = 0; index < 3; index += 1) await operation()
  const durations: number[] = []
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now()
    await operation()
    durations.push(performance.now() - started)
  }
  return { p50: round(percentile(durations, 0.5)), p95: round(percentile(durations, 0.95)), max: round(Math.max(...durations)) }
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true })
  const compiled = VISUALIZATION_EVAL_CORPUS.map(sample => {
    const result = compileVisualizationDraft(sample.draft, { mode: 'final' })
    if (result.status !== 'ok') throw new Error(`${sample.id}: ${JSON.stringify(result)}`)
    const repeated = compileVisualizationDraft(sample.draft, { mode: 'final' })
    if (repeated.status !== 'ok' || repeated.html !== result.html) throw new Error(`${sample.id}: 重编译不确定`)
    return { id: sample.id, html: result.html }
  })
  const samples = VISUALIZATION_EVAL_CORPUS.map(sample => {
    const generated = compiled.find(item => item.id === sample.id)!.html
    return {
      id: sample.id,
      scenarios: sample.scenarios,
      htmlTokens: estimateTextTokens(sample.html),
      draftTokens: estimateTextTokens(sample.draft),
      htmlBytes: Buffer.byteLength(sample.html),
      draftBytes: Buffer.byteLength(sample.draft),
      generatedBytes: Buffer.byteLength(generated),
      reduction: round(1 - estimateTextTokens(sample.draft) / estimateTextTokens(sample.html))
    }
  })
  const ratios = samples.map(sample => sample.draftTokens / sample.htmlTokens)
  const html = VISUALIZATION_EVAL_CORPUS.map(sample => sample.html).join('\n')
  const baselinePerformance = await measure(async () => {
    const issues = await validateVisualizationHtml(html)
    if (issues.length > 0) throw new Error(issues.join('\n'))
  }, 15)
  const generatedHtml = compiled.map(sample => sample.html).join('\n')
  const outputValidation = await measure(async () => {
    const issues = await validateVisualizationHtml(generatedHtml)
    if (issues.length > 0) throw new Error(issues.join('\n'))
  }, 5)
  const maximalDraft = Array.from({ length: 24 }, (_, panel) => {
    const text = `面板 ${panel + 1} 的内容${'长'.repeat(1250)}`
    return `## 容量面板 ${panel + 1}\n\n${text}\n\n${text}`
  }).join('\n\n')
  if (maximalDraft.length > 64_000) throw new Error(`最大语料超限: ${maximalDraft.length}`)
  const maximalPerformance = await measure(() => {
    const result = compileVisualizationDraft(maximalDraft, { mode: 'final' })
    if (result.status !== 'ok') throw new Error(JSON.stringify(result))
  }, 51)
  const result = {
    recordedAt: new Date().toISOString(),
    tokenizer: 'src/shared/model/tokenEstimate.ts estimateTextTokens',
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model ?? 'unknown', memoryBytes: totalmem() },
    sampleCount: samples.length,
    medianReduction: round(1 - percentile(ratios, 0.5)),
    everyDraftNoLarger: samples.every(sample => sample.draftTokens <= sample.htmlTokens),
    samples,
    baselinePerformance: { ...baselinePerformance, inputBytes: Buffer.byteLength(html), note: '预热后现有 validateVisualizationHtml' },
    compiler: {
      deterministicCorpus: true,
      outputValidation,
      maximalDraft: { chars: maximalDraft.length, panels: 24, ...maximalPerformance },
      thresholds: { p50: 8, p95: 16, max: 50 }
    }
  }
  await writeFile(path.join(OUTPUT_DIR, 'baseline-results.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
  await writeFile(path.join(OUTPUT_DIR, 'ab-results.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
  console.log(JSON.stringify(result, null, 2))
}

void main()
