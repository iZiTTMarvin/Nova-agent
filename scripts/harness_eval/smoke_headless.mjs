import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const workspace = mkdtempSync(join(tmpdir(), 'nova-headless-smoke-'))
const logs = join(workspace, 'logs')
let requestBody
let holdResponse = false
let toolCallsMode = false

const server = createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (holdResponse) {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache'
      })
      response.write(': waiting for deadline\n\n')
      return
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache'
    })
    if (toolCallsMode) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'smoke-tc', type: 'function', function: { name: 'ls', arguments: '{"path":"."}' } }] }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 17, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 7, completion_tokens: 3 } })}\n\n`)
      response.end('data: [DONE]\n\n')
      return
    }
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'smoke complete' }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 17, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 7, completion_tokens: 3 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
})

async function runHeadless(args, instruction, killAfterMs) {
  const child = spawn(
    process.execPath,
    [resolve('out/headless/nova-headless.cjs'), ...args],
    {
      cwd: resolve('.'),
      env: { ...process.env, DEEPSEEK_API_KEY: 'smoke-only-placeholder' },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  child.stdin.end(instruction)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  let killedByHarness = false
  const killTimer = killAfterMs === undefined
    ? undefined
    : setTimeout(() => {
        killedByHarness = true
        child.kill()
      }, killAfterMs)
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', resolveExit)
  })
  if (killTimer) clearTimeout(killTimer)
  return { exitCode, stdout, stderr, killedByHarness }
}

try {
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('failed to bind fake provider')
  const normal = await runHeadless(
    [
      '--workdir', workspace,
      '--logs-dir', logs,
      '--base-url', `http://127.0.0.1:${address.port}`,
      '--model', 'deepseek-v4-flash',
      '--reasoning-effort', 'max',
      '--max-tool-rounds', '2'
    ],
    'Return a short completion without using tools.'
  )
  if (normal.exitCode !== 0) {
    throw new Error(`headless exited ${normal.exitCode}: ${normal.stderr || normal.stdout}`)
  }

  const summary = JSON.parse(readFileSync(join(logs, 'summary.json'), 'utf8'))
  if (summary.status !== 'completed') throw new Error(`unexpected status: ${summary.status}`)
  if (summary.usage.uncachedInputTokens !== 7 || summary.usage.cacheReadTokens !== 10) {
    throw new Error(`usage normalization mismatch: ${JSON.stringify(summary.usage)}`)
  }
  if (requestBody?.model !== 'deepseek-v4-flash') throw new Error('model ID was not forwarded')
  if (requestBody?.reasoning_effort !== 'max') throw new Error('max effort was not forwarded')
  if (!Array.isArray(requestBody?.tools) || requestBody.tools.length !== 8) {
    throw new Error('coding tool registry was not forwarded')
  }

  holdResponse = true
  const deadlineLogs = join(workspace, 'deadline-logs')
  const deadline = await runHeadless(
    [
      '--workdir', workspace,
      '--logs-dir', deadlineLogs,
      '--base-url', `http://127.0.0.1:${address.port}`,
      '--model', 'deepseek-v4-flash',
      '--reasoning-effort', 'max',
      '--max-tool-rounds', '2',
      '--deadline-seconds', '0.1'
    ],
    'Wait for the provider so the deadline cancels this run.',
    2000
  )
  if (deadline.killedByHarness || deadline.exitCode !== 0) {
    throw new Error(`deadline run exited ${deadline.exitCode}: ${deadline.stderr || deadline.stdout}`)
  }
  const deadlineSummary = JSON.parse(readFileSync(join(deadlineLogs, 'summary.json'), 'utf8'))
  if (deadlineSummary.status !== 'cancelled' || deadlineSummary.budget_exhausted !== true) {
    throw new Error(`deadline summary mismatch: ${JSON.stringify(deadlineSummary)}`)
  }

  // 模型持续调用工具 → max_rounds 截断：退出码 1、failure_class=max_rounds、budget_exhausted=true
  holdResponse = false
  toolCallsMode = true
  const budgetLogs = join(workspace, 'budget-logs')
  const budget = await runHeadless(
    [
      '--workdir', workspace,
      '--logs-dir', budgetLogs,
      '--base-url', `http://127.0.0.1:${address.port}`,
      '--model', 'deepseek-v4-flash',
      '--reasoning-effort', 'max',
      '--max-tool-rounds', '2'
    ],
    'Keep calling tools until the round cap stops this run.'
  )
  if (budget.exitCode !== 1) {
    throw new Error(`budget run exited ${budget.exitCode}, expected 1: ${budget.stderr || budget.stdout}`)
  }
  const budgetSummary = JSON.parse(readFileSync(join(budgetLogs, 'summary.json'), 'utf8'))
  if (
    budgetSummary.status !== 'incomplete' ||
    budgetSummary.failure_class !== 'max_rounds' ||
    budgetSummary.budget_exhausted !== true
  ) {
    throw new Error(`budget summary mismatch: ${JSON.stringify(budgetSummary)}`)
  }
  // ATIF 逐步记录：2 轮工具调用 → 1 user step + 2 agent step，llm_call_count=2
  const trajectory = JSON.parse(readFileSync(join(budgetLogs, 'trajectory.json'), 'utf8'))
  if (
    trajectory.final_metrics.total_steps !== 3 ||
    trajectory.steps.filter(step => step.source === 'agent').length !== 2 ||
    budgetSummary.model_calls !== 2 ||
    budgetSummary.tool_calls !== 2
  ) {
    throw new Error(`ATIF step recording mismatch: ${JSON.stringify(trajectory)}`)
  }
  // 修复分型 telemetry：normal 场景无修复，全零
  if (summary.repair?.native_xml !== 0 || summary.repair?.empty_args_from_content !== 0) {
    throw new Error(`repair totals mismatch: ${JSON.stringify(summary.repair)}`)
  }
  if (
    summary.repair_outcome?.native_xml?.success !== 0 ||
    summary.repair_outcome?.native_xml?.failure !== 0
  ) {
    throw new Error(`repair outcome mismatch: ${JSON.stringify(summary.repair_outcome)}`)
  }
  process.stdout.write('headless smoke passed\n')
} finally {
  await new Promise(resolveClose => server.close(resolveClose))
  rmSync(workspace, { recursive: true, force: true })
}
