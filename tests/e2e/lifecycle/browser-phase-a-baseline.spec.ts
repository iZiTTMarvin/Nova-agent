import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test } from '../fixtures/nova'
import { BROWSER_CLOSE, BROWSER_OPEN } from '../../../src/shared/ipc/channels'

/** 记录三态进程树与打开延迟。预算只作对照，超限不改阈值、不把失败改成通过。 */
const PRIVATE_BUDGET_MIB = 10
const STARTUP_DELTA_BUDGET_MS = 50
const SURFACE_OPEN_TRIALS = 20
const MEMORY_TRIALS = 5
const SETTLE_MS = 1500

interface TypeBucket {
  count: number
  privateMiB: number
  workingSetMiB: number
}

interface TreeSample {
  label: string
  index: number
  processCount: number
  sumPrivateMiB: number
  sumWorkingSetMiB: number
  byType: Record<string, TypeBucket>
}

async function startGuestFixture(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>baseline</title><body>baseline</body>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
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

test('阶段 A 记录浏览器关/开未用/开着页面三态进程树与启动影响', async ({ nova }) => {
  test.setTimeout(180_000)
  const fixture = await startGuestFixture()
  const sampleTree = (label: string, index: number): Promise<TreeSample> =>
    nova.app.evaluate(({ app }, payload) => {
      const rows = app.getAppMetrics()
      const byType: Record<string, TypeBucket> = {}
      let sumPrivateMiB = 0
      let sumWorkingSetMiB = 0
      for (const row of rows) {
        const privateMiB = row.memory?.privateBytes != null ? row.memory.privateBytes / 1024 : 0
        const workingSetMiB = (row.memory?.workingSetSize ?? 0) / 1024
        sumPrivateMiB += privateMiB
        sumWorkingSetMiB += workingSetMiB
        const key = row.serviceName ? `${row.type}:${row.serviceName}` : row.type
        const bucket = byType[key] ?? { count: 0, privateMiB: 0, workingSetMiB: 0 }
        bucket.count += 1
        bucket.privateMiB += privateMiB
        bucket.workingSetMiB += workingSetMiB
        byType[key] = bucket
      }
      return {
        label: payload.label,
        index: payload.index,
        processCount: rows.length,
        sumPrivateMiB,
        sumWorkingSetMiB,
        byType
      }
    }, { label, index })

  async function sampleState(label: string): Promise<TreeSample[]> {
    await delay(SETTLE_MS)
    const rows: TreeSample[] = []
    for (let index = 0; index < MEMORY_TRIALS; index += 1) {
      rows.push(await sampleTree(label, index))
      await delay(200)
    }
    return rows
  }

  try {
    await expect(nova.page.getByTestId('browser-panel')).toHaveCount(0)
    const samplesA = await sampleState('A')

    const firstOpenStarted = Date.now()
    await nova.page.getByRole('button', { name: '在 Nova 中打开' }).click()
    await expect(nova.page.getByTestId('browser-panel')).toBeVisible()
    const firstOpenMs = Date.now() - firstOpenStarted
    const samplesB = await sampleState('B')

    const workspace = await nova.getWorkspace()
    const sessionId = workspace.currentSessionId
    expect(sessionId).toBeTruthy()
    const opened = await nova.invoke(BROWSER_OPEN, {
      sessionId: sessionId!,
      url: fixture.url
    })
    expect(opened.status).toBe('applied')
    await expect(nova.page.locator('webview[data-browser-id]')).toBeVisible()
    const samplesC = await sampleState('C')

    if (opened.status === 'applied') {
      await nova.invoke(BROWSER_CLOSE, {
        sessionId: sessionId!,
        browserId: opened.page.browserId
      })
    }
    await nova.page.getByRole('button', { name: '关闭页面' }).click()
    await expect(nova.page.getByTestId('browser-panel')).toHaveCount(0)

    const openLatenciesMs: number[] = [firstOpenMs]
    for (let index = 1; index < SURFACE_OPEN_TRIALS; index += 1) {
      const started = Date.now()
      await nova.page.getByRole('button', { name: '在 Nova 中打开' }).click()
      await expect(nova.page.getByTestId('browser-panel')).toBeVisible()
      openLatenciesMs.push(Date.now() - started)
      await nova.page.getByRole('button', { name: '关闭页面' }).click()
      await expect(nova.page.getByTestId('browser-panel')).toHaveCount(0)
    }

    const reloadLatenciesMs: number[] = []
    for (let index = 0; index < SURFACE_OPEN_TRIALS; index += 1) {
      const started = Date.now()
      await nova.page.reload()
      await expect(nova.page.getByLabel('消息输入')).toBeVisible()
      reloadLatenciesMs.push(Date.now() - started)
    }

    const privateA = median(samplesA.map((row) => row.sumPrivateMiB))
    const privateB = median(samplesB.map((row) => row.sumPrivateMiB))
    const privateC = median(samplesC.map((row) => row.sumPrivateMiB))
    const deltaBA = privateB - privateA
    const openP95 = percentile(openLatenciesMs, 95)
    const reloadP95 = percentile(reloadLatenciesMs, 95)

    const versions = await nova.app.evaluate(() => ({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }))
    let commit = 'unknown'
    try {
      commit = execSync('git rev-parse --short HEAD', { cwd: path.resolve(__dirname, '../../..') }).toString().trim()
    } catch {
      commit = 'unknown'
    }

    const dump = {
      budget: {
        privateDeltaBAMiB: PRIVATE_BUDGET_MIB,
        startupDeltaMs: STARTUP_DELTA_BUDGET_MS
      },
      environment: {
        commit,
        platform: process.platform,
        osRelease: os.release(),
        arch: os.arch(),
        cpus: os.cpus()[0]?.model ?? 'unknown',
        totalmemGiB: os.totalmem() / 1024 / 1024 / 1024,
        electron: versions.electron,
        chrome: versions.chrome,
        node: versions.node
      },
      memory: {
        A: { medianPrivateMiB: privateA, samples: samplesA },
        B: { medianPrivateMiB: privateB, samples: samplesB },
        C: { medianPrivateMiB: privateC, samples: samplesC },
        deltaBAMiB: deltaBA,
        deltaCBMiB: privateC - privateB
      },
      startup: {
        surfaceOpenMs: openLatenciesMs,
        surfaceOpenP50Ms: median(openLatenciesMs),
        surfaceOpenP95Ms: openP95,
        rendererReloadMs: reloadLatenciesMs,
        rendererReloadP50Ms: median(reloadLatenciesMs),
        rendererReloadP95Ms: reloadP95,
        note: '没有无浏览器代码的对照构建，无法对整应用冷启动做真正的 A/B 增量；surfaceOpen 是点开空浏览窗的延迟，rendererReload 是已编译该能力后的界面重载。'
      }
    }

    const reportDir = path.resolve(
      __dirname,
      '../../../docs/Local_Docs/评估报告/2026-09-21-浏览器阶段A性能基线'
    )
    await mkdir(reportDir, { recursive: true })
    await writeFile(path.join(reportDir, 'raw.json'), `${JSON.stringify(dump, null, 2)}\n`, 'utf8')
    await test.info().attach('browser-phase-a-baseline.json', {
      body: Buffer.from(JSON.stringify(dump, null, 2)),
      contentType: 'application/json'
    })
    console.log(
      `phase-a-baseline: B-A=${deltaBA.toFixed(2)} MiB A=${privateA.toFixed(2)} B=${privateB.toFixed(2)} C=${privateC.toFixed(2)} openP95=${openP95.toFixed(1)}ms reloadP95=${reloadP95.toFixed(1)}ms`
    )
    test.info().annotations.push({
      type: 'budget',
      description: `B-A ${deltaBA.toFixed(2)} MiB / ${PRIVATE_BUDGET_MIB}；openP95 ${openP95.toFixed(1)} ms / ${STARTUP_DELTA_BUDGET_MS}`
    })
  } finally {
    await fixture.close()
  }
})
