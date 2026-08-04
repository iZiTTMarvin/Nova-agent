import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const workspace = mkdtempSync(join(tmpdir(), 'nova-headless-smoke-'))
const logs = join(workspace, 'logs')
let requestBody
let holdResponse = false

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
  if (!Array.isArray(requestBody?.tools) || requestBody.tools.length !== 7) {
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
  process.stdout.write('headless smoke passed\n')
} finally {
  await new Promise(resolveClose => server.close(resolveClose))
  rmSync(workspace, { recursive: true, force: true })
}
