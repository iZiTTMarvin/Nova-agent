import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []

interface SummaryOptions {
  readonly enabled: boolean
  readonly resultBytes: number
  readonly compactions: number
  readonly contextWindow?: number
  readonly caseName?: string
  readonly instructionSha?: string
  readonly promptSha?: string
  readonly omitResultBytes?: boolean
  readonly actualCacheReadTokens?: number | null
}

function writeSummary(root: string, name: string, options: SummaryOptions): string {
  const filePath = join(root, `${name}.json`)
  const summary: Record<string, unknown> = {
    schema_version: 2,
    evaluation: {
      case: options.caseName ?? 'fixture:task',
      instruction_sha256: options.instructionSha ?? 'instruction',
      stable_prompt_sha256: options.promptSha ?? 'prompt',
      provider_sha256: 'provider',
      workspace_path_sha256: 'workspace',
      context_window: options.contextWindow ?? 200_000
    },
    model: 'model',
    reasoning_effort: 'max',
    max_tool_rounds: 20,
    deadline_seconds: 60,
    task_policy: { tier: 'normal', tool_economy: false },
    status: 'completed',
    duration_seconds: 1,
    tool_calls: 2,
    model_calls: 2,
    tool_call_counts: {
      read: 1,
      grep: 0,
      find: 0,
      code_context: options.enabled ? 1 : 0
    },
    tool_result_bytes: options.resultBytes,
    compaction_count: options.compactions,
    usage: {
      uncachedInputTokens: 10,
      cacheReadTokens: 20,
      outputTokens: 5
    },
    code_graph: {
      enabled: options.enabled,
      anchors_returned: options.enabled ? 1 : 0,
      index_status: options.enabled ? 'ready' : 'disabled',
      index_revision: options.enabled ? 1 : 0,
      query_latency_ms: { total: 1, max: 1, average: 1, p50: 1, p95: 1 }
    },
    cache_diagnostics: {
      tools_bytes: 100,
      expected_reuse_tokens: 20,
      actual_cache_read_tokens: options.actualCacheReadTokens === undefined
        ? 20
        : options.actualCacheReadTokens,
      first_diff_part: null,
      first_diff_index: null,
      estimated_invalidated_tokens: 0,
      epoch_id: 'epoch_0',
      epoch_reason: 'session_init'
    }
  }
  if (options.omitResultBytes) delete summary.tool_result_bytes
  writeFileSync(filePath, JSON.stringify(summary), 'utf8')
  return filePath
}

function compare(baseline: string, experiment: string) {
  return spawnSync(process.execPath, [
    resolve('scripts/harness_eval/compare_code_graph_ab.mjs'),
    '--baseline',
    baseline,
    '--experiment',
    experiment
  ], { encoding: 'utf8' })
}

describe('headless code graph A/B gate', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('工具结果字节与压缩次数不增加时通过', () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-code-graph-ab-'))
    roots.push(root)
    const result = compare(
      writeSummary(root, 'baseline', { enabled: false, resultBytes: 800, compactions: 1 }),
      writeSummary(root, 'experiment', { enabled: true, resultBytes: 700, compactions: 1 })
    )

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).context_cost).toEqual({
      tool_result_bytes_non_increasing: true,
      compaction_count_non_increasing: true,
      pass: true
    })
  })

  it('工具结果净字节上升时拒绝实验臂', () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-code-graph-ab-'))
    roots.push(root)
    const result = compare(
      writeSummary(root, 'baseline', { enabled: false, resultBytes: 800, compactions: 0 }),
      writeSummary(root, 'experiment', { enabled: true, resultBytes: 801, compactions: 0 })
    )

    expect(result.status).toBe(2)
    expect(JSON.parse(result.stdout).context_cost.pass).toBe(false)
  })

  it('关键指标缺失、任务不一致或上下文窗口不一致时关闭比较', () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-code-graph-ab-'))
    roots.push(root)
    const missingMetric = compare(
      writeSummary(root, 'baseline-missing', {
        enabled: false,
        resultBytes: 800,
        compactions: 0,
        omitResultBytes: true
      }),
      writeSummary(root, 'experiment-valid', {
        enabled: true,
        resultBytes: 700,
        compactions: 0
      })
    )
    const mismatchedTask = compare(
      writeSummary(root, 'baseline-task', {
        enabled: false,
        resultBytes: 800,
        compactions: 0
      }),
      writeSummary(root, 'experiment-task', {
        enabled: true,
        resultBytes: 700,
        compactions: 0,
        caseName: 'fixture:other-task',
        instructionSha: 'other-instruction'
      })
    )
    const mismatchedContext = compare(
      writeSummary(root, 'baseline-context', {
        enabled: false,
        resultBytes: 800,
        compactions: 0
      }),
      writeSummary(root, 'experiment-context', {
        enabled: true,
        resultBytes: 700,
        compactions: 0,
        contextWindow: 100_000
      })
    )

    expect(missingMetric.status).toBe(1)
    expect(mismatchedTask.status).toBe(1)
    expect(mismatchedContext.status).toBe(1)
  })

  it('稳定提示词不一致时关闭比较', () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-code-graph-ab-'))
    roots.push(root)
    const result = compare(
      writeSummary(root, 'baseline', {
        enabled: false,
        resultBytes: 800,
        compactions: 1,
        promptSha: 'baseline-prompt'
      }),
      writeSummary(root, 'experiment', {
        enabled: true,
        resultBytes: 700,
        compactions: 1,
        promptSha: 'experiment-prompt'
      })
    )

    expect(result.status).toBe(1)
  })

  it('缓存命中尚未回填时仍比较工具结果字节', () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-code-graph-ab-'))
    roots.push(root)
    const result = compare(
      writeSummary(root, 'baseline', {
        enabled: false,
        resultBytes: 800,
        compactions: 1,
        actualCacheReadTokens: null
      }),
      writeSummary(root, 'experiment', {
        enabled: true,
        resultBytes: 700,
        compactions: 1,
        actualCacheReadTokens: null
      })
    )

    expect(result.status).toBe(0)
  })
})
