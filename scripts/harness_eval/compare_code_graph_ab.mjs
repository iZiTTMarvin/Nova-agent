import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function parseArgs(argv) {
  if (argv.length !== 4) {
    throw new Error('用法：--baseline <summary.json> --experiment <summary.json>')
  }
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if ((flag !== '--baseline' && flag !== '--experiment') || !value || values.has(flag)) {
      throw new Error('用法：--baseline <summary.json> --experiment <summary.json>')
    }
    values.set(flag, resolve(value))
  }
  if (!values.has('--baseline') || !values.has('--experiment')) {
    throw new Error('必须同时提供 baseline 与 experiment summary')
  }
  return {
    baseline: values.get('--baseline'),
    experiment: values.get('--experiment')
  }
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`)
  }
  return value
}

function string(recordValue, key, label) {
  const value = recordValue[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label}.${key} 必须是非空字符串`)
  }
  return value
}

function nullableString(recordValue, key, label) {
  const value = recordValue[key]
  if (value !== null && typeof value !== 'string') {
    throw new Error(`${label}.${key} 必须是字符串或 null`)
  }
  return value
}

function boolean(recordValue, key, label) {
  const value = recordValue[key]
  if (typeof value !== 'boolean') throw new Error(`${label}.${key} 必须是布尔值`)
  return value
}

function number(recordValue, key, label) {
  const value = recordValue[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label}.${key} 必须是非负有限数`)
  }
  return value
}

function integer(recordValue, key, label) {
  const value = number(recordValue, key, label)
  if (!Number.isInteger(value)) throw new Error(`${label}.${key} 必须是整数`)
  return value
}

function nullableNumber(recordValue, key, label) {
  const value = recordValue[key]
  if (value === null) return null
  return number(recordValue, key, label)
}

function nullableInteger(recordValue, key, label) {
  const value = nullableNumber(recordValue, key, label)
  if (value !== null && !Number.isInteger(value)) {
    throw new Error(`${label}.${key} 必须是整数或 null`)
  }
  return value
}

function readSummary(filePath) {
  const summary = record(JSON.parse(readFileSync(filePath, 'utf8')), filePath)
  if (summary.schema_version !== 2) {
    throw new Error(`不支持的 headless summary schema：${filePath}`)
  }
  const evaluation = record(summary.evaluation, `${filePath}.evaluation`)
  const taskPolicy = record(summary.task_policy, `${filePath}.task_policy`)
  const counts = record(summary.tool_call_counts, `${filePath}.tool_call_counts`)
  const usage = record(summary.usage, `${filePath}.usage`)
  const codeGraph = record(summary.code_graph, `${filePath}.code_graph`)
  const latency = record(codeGraph.query_latency_ms, `${filePath}.code_graph.query_latency_ms`)
  const cache = record(summary.cache_diagnostics, `${filePath}.cache_diagnostics`)
  const comparable = {
    model: string(summary, 'model', filePath),
    reasoning_effort: string(summary, 'reasoning_effort', filePath),
    max_tool_rounds: nullableInteger(summary, 'max_tool_rounds', filePath),
    deadline_seconds: nullableNumber(summary, 'deadline_seconds', filePath),
    evaluation: {
      case: nullableString(evaluation, 'case', `${filePath}.evaluation`),
      instruction_sha256: string(evaluation, 'instruction_sha256', `${filePath}.evaluation`),
      stable_prompt_sha256: string(evaluation, 'stable_prompt_sha256', `${filePath}.evaluation`),
      provider_sha256: string(evaluation, 'provider_sha256', `${filePath}.evaluation`),
      workspace_path_sha256: string(evaluation, 'workspace_path_sha256', `${filePath}.evaluation`),
      context_window: integer(evaluation, 'context_window', `${filePath}.evaluation`)
    },
    task_policy: taskPolicy
  }
  const metrics = {
    status: string(summary, 'status', filePath),
    read_calls: integer(counts, 'read', `${filePath}.tool_call_counts`),
    grep_calls: integer(counts, 'grep', `${filePath}.tool_call_counts`),
    find_calls: integer(counts, 'find', `${filePath}.tool_call_counts`),
    code_context_calls: integer(counts, 'code_context', `${filePath}.tool_call_counts`),
    total_tool_calls: integer(summary, 'tool_calls', filePath),
    llm_request_count: integer(summary, 'model_calls', filePath),
    input_tokens:
      integer(usage, 'uncachedInputTokens', `${filePath}.usage`) +
      integer(usage, 'cacheReadTokens', `${filePath}.usage`),
    output_tokens: integer(usage, 'outputTokens', `${filePath}.usage`),
    duration_seconds: number(summary, 'duration_seconds', filePath),
    tool_result_bytes: integer(summary, 'tool_result_bytes', filePath),
    compaction_count: integer(summary, 'compaction_count', filePath),
    anchors_returned: integer(codeGraph, 'anchors_returned', `${filePath}.code_graph`),
    index_status: string(codeGraph, 'index_status', `${filePath}.code_graph`),
    index_revision: integer(codeGraph, 'index_revision', `${filePath}.code_graph`),
    query_latency_p50_ms: number(latency, 'p50', `${filePath}.code_graph.query_latency_ms`),
    query_latency_p95_ms: number(latency, 'p95', `${filePath}.code_graph.query_latency_ms`),
    tools_bytes: integer(cache, 'tools_bytes', `${filePath}.cache_diagnostics`),
    expected_reuse_tokens: integer(cache, 'expected_reuse_tokens', `${filePath}.cache_diagnostics`),
    actual_cache_read_tokens: nullableInteger(
      cache,
      'actual_cache_read_tokens',
      `${filePath}.cache_diagnostics`
    ),
    first_diff_part: nullableString(cache, 'first_diff_part', `${filePath}.cache_diagnostics`),
    first_diff_index: nullableInteger(cache, 'first_diff_index', `${filePath}.cache_diagnostics`),
    estimated_invalidated_tokens: integer(
      cache,
      'estimated_invalidated_tokens',
      `${filePath}.cache_diagnostics`
    ),
    epoch_id: string(cache, 'epoch_id', `${filePath}.cache_diagnostics`),
    epoch_reason: string(cache, 'epoch_reason', `${filePath}.cache_diagnostics`)
  }
  return {
    comparable,
    metrics,
    codeGraphEnabled: boolean(codeGraph, 'enabled', `${filePath}.code_graph`)
  }
}

function delta(baseline, experiment) {
  const result = {}
  for (const key of Object.keys(experiment)) {
    if (typeof experiment[key] === 'number' && typeof baseline[key] === 'number') {
      result[key] = experiment[key] - baseline[key]
    }
  }
  return result
}

const paths = parseArgs(process.argv.slice(2))
const baselineSummary = readSummary(paths.baseline)
const experimentSummary = readSummary(paths.experiment)
if (baselineSummary.codeGraphEnabled !== false) {
  throw new Error('baseline 必须关闭 code graph')
}
if (experimentSummary.codeGraphEnabled !== true) {
  throw new Error('experiment 必须开启 code graph')
}
if (JSON.stringify(baselineSummary.comparable) !== JSON.stringify(experimentSummary.comparable)) {
  throw new Error('A/B 的任务、语料标识、提示词、模型、上下文或预算不一致')
}

const contextCost = {
  tool_result_bytes_non_increasing:
    experimentSummary.metrics.tool_result_bytes <= baselineSummary.metrics.tool_result_bytes,
  compaction_count_non_increasing:
    experimentSummary.metrics.compaction_count <= baselineSummary.metrics.compaction_count
}
const result = {
  schema_version: 1,
  baseline: baselineSummary.metrics,
  experiment: experimentSummary.metrics,
  delta: delta(baselineSummary.metrics, experimentSummary.metrics),
  context_cost: { ...contextCost, pass: Object.values(contextCost).every(Boolean) }
}
process.stdout.write(`${JSON.stringify(result)}\n`)
if (!result.context_cost.pass) process.exitCode = 2
