/**
 * 发布闸口实测。预算数字与既有口径一致：privateBytes 按 KB 换成 MiB。
 * 超限只失败并留下原始数据，不改阈值。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test, type NovaHarness } from '../fixtures/nova'
import {
  BROWSER_CAPTURE,
  BROWSER_CLOSE,
  BROWSER_OBSERVE,
  BROWSER_OPEN,
  WORKSPACE_SET_PERMISSION_MODE
} from '../../../src/shared/ipc/channels'
import type { BrowserCaptureResult, BrowserObserveResult, BrowserOpenResult } from '../../../src/shared/browser'

const BA_BUDGET_MIB = 10
const CB_BUDGET_MIB = 250
const DC_BUDGET_MIB = 40
const EB_BUDGET_MIB = 30
const CYCLE_BUDGET_MIB = 10
const OBSERVE_P95_MS = 300
const CAPTURE_P95_MS = 700
const TRIALS = 5
const CYCLES = 30
const SETTLE_MS = 1500

interface TypeBucket {
  count: number
  privateMiB: number
}

interface TreeSample {
  label: string
  index: number
  processCount: number
  webviewCount: number
  sumPrivateMiB: number
  byType: Record<string, TypeBucket>
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  return sorted[Math.floor(sorted.length / 2)]!
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]!
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function grantFullAccess(nova: NovaHarness): Promise<string> {
  const workspace = await nova.getWorkspace()
  const sessionId = workspace.currentSessionId
  if (!sessionId) throw new Error('没有当前会话')
  await nova.invoke(WORKSPACE_SET_PERMISSION_MODE, { sessionId, permissionMode: 'full_access' })
  return sessionId
}

function sampleTree(nova: NovaHarness, label: string, index: number): Promise<TreeSample> {
  return nova.app.evaluate(({ app, webContents }, payload) => {
    const rows = app.getAppMetrics()
    const byType: Record<string, { count: number; privateMiB: number }> = {}
    let sumPrivateMiB = 0
    for (const row of rows) {
      const privateMiB = row.memory?.privateBytes != null ? row.memory.privateBytes / 1024 : 0
      sumPrivateMiB += privateMiB
      const key = row.serviceName ? `${row.type}:${row.serviceName}` : row.type
      const bucket = byType[key] ?? { count: 0, privateMiB: 0 }
      bucket.count += 1
      bucket.privateMiB += privateMiB
      byType[key] = bucket
    }
    const webviewCount = webContents.getAllWebContents().filter((item) => {
      try {
        return item.getType() === 'webview' && !item.isDestroyed()
      } catch {
        return false
      }
    }).length
    return {
      label: payload.label,
      index: payload.index,
      processCount: rows.length,
      webviewCount,
      sumPrivateMiB,
      byType
    }
  }, { label, index })
}

async function sampleState(nova: NovaHarness, label: string): Promise<TreeSample[]> {
  await delay(SETTLE_MS)
  const rows: TreeSample[] = []
  for (let index = 0; index < TRIALS; index += 1) {
    rows.push(await sampleTree(nova, label, index))
    await delay(200)
  }
  return rows
}

function environment(): Record<string, unknown> {
  let commit = 'unknown'
  try {
    commit = execSync('git rev-parse --short HEAD', { cwd: path.resolve(__dirname, '../../..') }).toString().trim()
  } catch {
    commit = 'unknown'
  }
  return {
    commit,
    platform: process.platform,
    osRelease: os.release(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model ?? 'unknown',
    totalMemGiB: Number((os.totalmem() / 1024 / 1024 / 1024).toFixed(2)),
    privateBytesUnit: 'Electron privateBytes / 1024 = MiB，与既有闸口相同'
  }
}

async function writeReport(name: string, dump: unknown): Promise<void> {
  const reportDir = path.resolve(__dirname, '../../../docs/Local_Docs/评估报告/2026-09-22-浏览器发布闸口')
  await mkdir(reportDir, { recursive: true })
  await writeFile(path.join(reportDir, name), `${JSON.stringify(dump, null, 2)}\n`, 'utf8')
}

function listen(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done, reject) => {
          server.close((error) => (error ? reject(error) : done()))
        })
      })
    })
  })
}

test('五态对照与观察截图时延', async ({ nova }) => {
  test.setTimeout(180_000)
  const fixture = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>plain</title><body><p>plain</p></body>')
  })
  try {
    const sessionId = await grantFullAccess(nova)
    await expect(nova.page.getByTestId('browser-panel')).toHaveCount(0)
    const samplesA = await sampleState(nova, 'A')

    const openStarted = Date.now()
    await nova.page.getByRole('button', { name: '在 Nova 中打开' }).click()
    await expect(nova.page.getByTestId('browser-panel')).toBeVisible()
    const surfaceOpenMs = Date.now() - openStarted
    const samplesB = await sampleState(nova, 'B')

    const opened = await nova.invoke(BROWSER_OPEN, {
      sessionId,
      url: `${fixture.origin}/`
    }) as BrowserOpenResult
    expect(opened.status).toBe('applied')
    if (opened.status !== 'applied') return
    await expect(nova.page.locator('webview[data-browser-id]')).toHaveCount(1)
    const samplesC = await sampleState(nova, 'C')

    const observeMs: number[] = []
    const captureMs: number[] = []
    const samplesD: TreeSample[] = []
    for (let index = 0; index < TRIALS; index += 1) {
      const observeStarted = Date.now()
      const observed = await nova.invoke(BROWSER_OBSERVE, {
        sessionId,
        browserId: opened.page.browserId
      }) as BrowserObserveResult
      observeMs.push(Date.now() - observeStarted)
      expect(observed.status).toBe('applied')
      if (observed.status !== 'applied') return
      const captureStarted = Date.now()
      const captured = await nova.invoke(BROWSER_CAPTURE, {
        sessionId,
        observation: observed.observation
      }) as BrowserCaptureResult
      captureMs.push(Date.now() - captureStarted)
      expect(captured.status).toBe('applied')
      samplesD.push(await sampleTree(nova, 'D', index))
    }

    await nova.invoke(BROWSER_CLOSE, { sessionId, browserId: opened.page.browserId })
    await expect(nova.page.locator('webview[data-browser-id]')).toHaveCount(0)
    const samplesE = await sampleState(nova, 'E')

    const privateA = median(samplesA.map((row) => row.sumPrivateMiB))
    const privateB = median(samplesB.map((row) => row.sumPrivateMiB))
    const privateC = median(samplesC.map((row) => row.sumPrivateMiB))
    const privateD = median(samplesD.map((row) => row.sumPrivateMiB))
    const privateE = median(samplesE.map((row) => row.sumPrivateMiB))
    const dump = {
      environment: environment(),
      budgetsMiB: { BA: BA_BUDGET_MIB, CB: CB_BUDGET_MIB, DC: DC_BUDGET_MIB, EB: EB_BUDGET_MIB },
      latencyBudgetsMs: { observeP95: OBSERVE_P95_MS, captureP95: CAPTURE_P95_MS },
      notClaimed: {
        coldStartP95Ms: '没有关掉浏览器代码的对照包，不能把点开空面板当成冷启动增量',
        surfaceOpenMs,
        cpuIdle: '未做 30 秒 CPU 窗口，不记空闲 CPU 通过',
        eventLoop: '未接 main event-loop 监测，不记 p99 通过'
      },
      memory: {
        A: privateA,
        B: privateB,
        C: privateC,
        D: privateD,
        E: privateE,
        BA: privateB - privateA,
        CB: privateC - privateB,
        DC: privateD - privateC,
        EB: privateE - privateB,
        samples: { A: samplesA, B: samplesB, C: samplesC, D: samplesD, E: samplesE }
      },
      latency: {
        observeMs,
        observeP95: percentile(observeMs, 95),
        captureMs,
        captureP95: percentile(captureMs, 95)
      },
      webviewsAtE: samplesE.map((row) => row.webviewCount)
    }
    await writeReport('five-state.json', dump)
    console.log(
      `release-five-state: BA=${dump.memory.BA.toFixed(2)} CB=${dump.memory.CB.toFixed(2)} DC=${dump.memory.DC.toFixed(2)} EB=${dump.memory.EB.toFixed(2)} observeP95=${dump.latency.observeP95} captureP95=${dump.latency.captureP95}`
    )
    expect(dump.memory.BA).toBeLessThanOrEqual(BA_BUDGET_MIB)
    expect(dump.memory.CB).toBeLessThanOrEqual(CB_BUDGET_MIB)
    expect(dump.memory.DC).toBeLessThanOrEqual(DC_BUDGET_MIB)
    expect(dump.memory.EB).toBeLessThanOrEqual(EB_BUDGET_MIB)
    expect(dump.latency.observeP95).toBeLessThanOrEqual(OBSERVE_P95_MS)
    expect(dump.latency.captureP95).toBeLessThanOrEqual(CAPTURE_P95_MS)
    expect(samplesE.every((row) => row.webviewCount === 0)).toBe(true)
  } finally {
    await fixture.close()
  }
})

test('繁重动画页与流式聊天可以同时进行', async ({ nova }) => {
  test.setTimeout(120_000)
  const fixture = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><title>webgl</title><body><canvas id="c" width="640" height="480"></canvas>
<script>
const canvas = document.getElementById('c')
const gl = canvas.getContext('webgl')
let frames = 0
function tick() {
  frames += 1
  if (gl) {
    gl.clearColor((frames % 80) / 80, 0.2, 0.35, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }
  requestAnimationFrame(tick)
}
tick()
</script></body>`)
  })
  try {
    const sessionId = await grantFullAccess(nova)
    const opened = await nova.invoke(BROWSER_OPEN, {
      sessionId,
      url: `${fixture.origin}/`
    }) as BrowserOpenResult
    expect(opened.status).toBe('applied')
    await expect(nova.page.locator('webview[data-browser-id]')).toHaveCount(1)
    await delay(800)
    const frames = await nova.app.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find((item) => {
        try {
          return item.getType() === 'webview' && !item.isDestroyed()
        } catch {
          return false
        }
      })
      if (!guest) return { frames: 0, gl: false }
      return guest.executeJavaScript(`({ frames, gl: Boolean(document.getElementById('c').getContext('webgl')) })`)
    })
    const heavy = await sampleTree(nova, 'heavy', 0)
    nova.provider.enqueue({
      kind: 'text',
      text: 'NOVA_E2E_STREAM_OK',
      chunks: ['NOVA_', 'E2E_', 'STREAM_', 'OK'],
      chunkDelayMs: 60
    })
    const streamStarted = Date.now()
    await nova.sendPrompt('边看动画边说话')
    await expect(nova.page.getByText('NOVA_E2E_STREAM_OK', { exact: false })).toBeVisible()
    const streamVisibleMs = Date.now() - streamStarted
    await nova.waitUntilIdle()
    const framesAfter = await nova.app.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find((item) => {
        try {
          return item.getType() === 'webview' && !item.isDestroyed()
        } catch {
          return false
        }
      })
      if (!guest) return 0
      return guest.executeJavaScript('frames')
    })
    const dump = {
      environment: environment(),
      webgl: frames,
      framesAfter,
      heavyPrivateMiB: heavy.sumPrivateMiB,
      heavyByType: heavy.byType,
      streamVisibleMs,
      note: '繁重页不套用普通页 250 MiB 承诺。流式可见时间含模型分块延迟，不把它记成输入响应 p95。'
    }
    await writeReport('heavy-stream.json', dump)
    console.log(`release-heavy: frames=${frames.frames} gl=${frames.gl} after=${framesAfter} streamVisibleMs=${streamVisibleMs} private=${heavy.sumPrivateMiB.toFixed(2)}`)
    expect(frames.gl).toBe(true)
    expect(frames.frames).toBeGreaterThan(0)
    expect(framesAfter).toBeGreaterThan(frames.frames)
  } finally {
    await fixture.close()
  }
})

test('三十次观察并截图后关闭，残留不比前十次中位数高出 10 MiB', async ({ nova }) => {
  test.setTimeout(300_000)
  const fixture = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>cycle</title><body><p>cycle</p></body>')
  })
  const samples: TreeSample[] = []
  try {
    const sessionId = await grantFullAccess(nova)
    for (let index = 0; index < CYCLES; index += 1) {
      const opened = await nova.invoke(BROWSER_OPEN, {
        sessionId,
        url: `${fixture.origin}/`
      }) as BrowserOpenResult
      expect(opened.status).toBe('applied')
      if (opened.status !== 'applied') return
      await expect(nova.page.locator('webview[data-browser-id]')).toHaveCount(1)
      const observed = await nova.invoke(BROWSER_OBSERVE, {
        sessionId,
        browserId: opened.page.browserId
      }) as BrowserObserveResult
      expect(observed.status).toBe('applied')
      if (observed.status !== 'applied') return
      const captured = await nova.invoke(BROWSER_CAPTURE, {
        sessionId,
        observation: observed.observation
      }) as BrowserCaptureResult
      expect(captured.status).toBe('applied')
      const closed = await nova.invoke(BROWSER_CLOSE, {
        sessionId,
        browserId: opened.page.browserId
      })
      expect(closed.status).toBe('applied')
      await expect(nova.page.locator('webview[data-browser-id]')).toHaveCount(0)
      samples.push(await sampleTree(nova, 'cycle', index))
    }
    const first10 = samples.slice(0, 10).map((row) => row.sumPrivateMiB)
    const last10 = samples.slice(-10).map((row) => row.sumPrivateMiB)
    const delta = median(last10) - median(first10)
    const dump = {
      environment: environment(),
      budgetMiB: CYCLE_BUDGET_MIB,
      includes: '每次打开后观察并截图，再关闭，然后采样',
      first10MedianPrivateMiB: median(first10),
      last10MedianPrivateMiB: median(last10),
      deltaLastMinusFirstMiB: delta,
      webviewCounts: samples.map((row) => row.webviewCount),
      processCounts: samples.map((row) => row.processCount),
      samples
    }
    await writeReport('cycles.json', dump)
    console.log(`release-cycles: delta=${delta.toFixed(2)} MiB first10=${median(first10).toFixed(2)} last10=${median(last10).toFixed(2)}`)
    expect(delta).toBeLessThanOrEqual(CYCLE_BUDGET_MIB)
    expect(samples.every((row) => row.webviewCount === 0)).toBe(true)
  } finally {
    await fixture.close()
  }
})
