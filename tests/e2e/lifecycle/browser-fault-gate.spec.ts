import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test, type NovaHarness } from '../fixtures/nova'
import {
  BROWSER_CLOSE,
  BROWSER_GET_SNAPSHOT,
  BROWSER_NAVIGATE,
  BROWSER_OBSERVE,
  BROWSER_OPEN,
  WORKSPACE_SET_PERMISSION_MODE
} from '../../../src/shared/ipc/channels'
import type {
  BrowserListResult,
  BrowserNavigateResult,
  BrowserNotApplied,
  BrowserObserveResult,
  BrowserOpenResult
} from '../../../src/shared/browser'

const DC_BUDGET_MIB = 40
const MEMORY_TRIALS = 5
const SETTLE_MS = 1500

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`
}

async function startReadyFixture(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page('Gate', '<p id="copy">fault-gate</p>'))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

async function startHungFixture(): Promise<{ origin: string; close: () => Promise<void> }> {
  const sockets = new Set<import('node:net').Socket>()
  const server = http.createServer((_req, _res) => {
    // 故意不写响应，模拟加载挂起
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      for (const socket of sockets) socket.destroy()
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

async function grantFullAccess(nova: NovaHarness): Promise<string> {
  const workspace = await nova.getWorkspace()
  const sessionId = workspace.currentSessionId
  if (!sessionId) throw new Error('没有当前会话')
  await nova.invoke(WORKSPACE_SET_PERMISSION_MODE, { sessionId, permissionMode: 'full_access' })
  return sessionId
}

async function openReadyPage(nova: NovaHarness, sessionId: string, url: string): Promise<string> {
  const opened = await nova.invoke(BROWSER_OPEN, { sessionId, url }) as BrowserOpenResult
  expect(opened.status).toBe('applied')
  if (opened.status !== 'applied') throw new Error('打开页面失败')
  await nova.page.locator('webview[data-browser-id]').waitFor()
  return opened.page.browserId
}

function notAppliedCode(result: BrowserNotApplied | { status: string }): string | null {
  return result.status === 'not_applied' ? (result as BrowserNotApplied).code : null
}

async function crashGuestRenderer(nova: NovaHarness): Promise<number> {
  return nova.app.evaluate(({ webContents }) => {
    const guests = webContents.getAllWebContents().filter((item) => {
      try {
        return item.getType() === 'webview' && !item.isDestroyed()
      } catch {
        return false
      }
    })
    for (const guest of guests) guest.forcefullyCrashRenderer()
    return guests.length
  })
}

async function chatStillWorks(nova: NovaHarness, token: string): Promise<void> {
  await expect(nova.page.getByLabel('消息输入')).toBeVisible()
  nova.provider.enqueue({ kind: 'text', text: token })
  await nova.sendPrompt('确认聊天还活着')
  await expect(nova.page.getByText(token, { exact: false })).toBeVisible()
  await nova.waitUntilIdle()
}

interface TypeBucket {
  count: number
  privateMiB: number
}

interface TreeSample {
  label: string
  index: number
  processCount: number
  sumPrivateMiB: number
  byType: Record<string, TypeBucket>
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  return sorted[Math.floor(sorted.length / 2)]!
}

test('页面崩溃后聊天仍可继续，观察返回 page_crashed', async ({ nova }) => {
  test.setTimeout(90_000)
  const sessionId = await grantFullAccess(nova)
  const fixture = await startReadyFixture()
  try {
    const browserId = await openReadyPage(nova, sessionId, `${fixture.origin}/`)
    expect(await crashGuestRenderer(nova)).toBeGreaterThan(0)
    await expect.poll(async () => {
      const listed = await nova.invoke(BROWSER_GET_SNAPSHOT, { sessionId }) as BrowserListResult
      if (listed.status !== 'applied') return null
      return listed.snapshot.pages.find((item) => item.browserId === browserId)?.lifecycle ?? null
    }).toBe('crashed')
    const observed = await nova.invoke(BROWSER_OBSERVE, { sessionId, browserId }) as BrowserObserveResult
    expect(notAppliedCode(observed)).toBe('page_crashed')
    await chatStillWorks(nova, 'NOVA_E2E_BROWSER_CRASH_CHAT_OK')
  } finally {
    await fixture.close()
  }
})

test('加载挂起会在时限内失败，聊天不被拖死', async ({ nova }) => {
  test.setTimeout(90_000)
  const sessionId = await grantFullAccess(nova)
  const ready = await startReadyFixture()
  const hung = await startHungFixture()
  try {
    const browserId = await openReadyPage(nova, sessionId, `${ready.origin}/`)
    const started = Date.now()
    const navigated = await nova.invoke(BROWSER_NAVIGATE, {
      sessionId,
      browserId,
      action: { kind: 'url', url: `${hung.origin}/stall` }
    }) as BrowserNavigateResult
    expect(Date.now() - started).toBeLessThan(12_000)
    expect(notAppliedCode(navigated)).toBe('timeout')
    await chatStillWorks(nova, 'NOVA_E2E_BROWSER_HANG_CHAT_OK')
  } finally {
    await ready.close()
    await hung.close()
  }
})

test('任务取消会结束挂起的网页命令，页面保留且聊天可继续', async ({ nova }) => {
  test.setTimeout(90_000)
  const sessionId = await grantFullAccess(nova)
  const hung = await startHungFixture()
  try {
    const opened = await nova.invoke(BROWSER_OPEN, {
      sessionId,
      url: `${hung.origin}/stall`
    }) as BrowserOpenResult
    expect(opened.status).toBe('applied')
    if (opened.status !== 'applied') throw new Error('打开挂起页失败')
    const browserId = opened.page.browserId
    await nova.page.locator('webview[data-browser-id]').waitFor()

    nova.provider.setTurnFactory(() => ({
      kind: 'tool',
      name: 'browser_observe',
      arguments: { action: 'snapshot', browserId },
      callId: 'e2e_browser_cancel_observe'
    }))
    await nova.sendPrompt('观察这个还在加载的页面')
    await expect(nova.page.getByRole('button', { name: '中断生成' })).toBeVisible()
    await nova.page.getByRole('button', { name: '中断生成' }).click()
    await nova.waitUntilIdle()
    await expect.poll(async () => (await nova.getRunSnapshot())?.status).toBe('cancelled')
    nova.provider.setTurnFactory(null)
    const listed = await nova.invoke(BROWSER_GET_SNAPSHOT, { sessionId }) as BrowserListResult
    expect(listed.status).toBe('applied')
    if (listed.status === 'applied') {
      expect(listed.snapshot.pages.some((item) => item.browserId === browserId)).toBe(true)
    }
    await chatStillWorks(nova, 'NOVA_E2E_BROWSER_CANCEL_CHAT_OK')
  } finally {
    await hung.close()
  }
})

test('关闭进行中的加载时，旧命令不会落到已关页面', async ({ nova }) => {
  test.setTimeout(90_000)
  const sessionId = await grantFullAccess(nova)
  const ready = await startReadyFixture()
  const hung = await startHungFixture()
  try {
    const browserId = await openReadyPage(nova, sessionId, `${ready.origin}/`)
    const started = Date.now()
    const hanging = nova.invoke(BROWSER_NAVIGATE, {
      sessionId,
      browserId,
      action: { kind: 'url', url: `${hung.origin}/stall` }
    })
    await delay(200)
    const closed = await nova.invoke(BROWSER_CLOSE, { sessionId, browserId })
    const navigated = await hanging
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(closed.status).toBe('applied')
    expect(['page_closed', 'cancelled']).toContain(notAppliedCode(navigated))
    const listed = await nova.invoke(BROWSER_GET_SNAPSHOT, { sessionId }) as BrowserListResult
    if (listed.status === 'applied') {
      expect(listed.snapshot.pages.some((item) => item.browserId === browserId)).toBe(false)
    }
    await chatStillWorks(nova, 'NOVA_E2E_BROWSER_CLOSE_CHAT_OK')
  } finally {
    await ready.close()
    await hung.close()
  }
})

test('记录观察附加内存，预算 40 MiB 不放宽', async ({ nova }) => {
  test.setTimeout(90_000)
  const sessionId = await grantFullAccess(nova)
  const fixture = await startReadyFixture()
  const sampleTree = (label: string, index: number): Promise<TreeSample> =>
    nova.app.evaluate(({ app }, payload) => {
      const rows = app.getAppMetrics()
      const byType: Record<string, TypeBucket> = {}
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
      return {
        label: payload.label,
        index: payload.index,
        processCount: rows.length,
        sumPrivateMiB,
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
    const browserId = await openReadyPage(nova, sessionId, `${fixture.origin}/`)
    const samplesC = await sampleState('C')
    const samplesD: TreeSample[] = []
    for (let index = 0; index < MEMORY_TRIALS; index += 1) {
      const observed = await nova.invoke(BROWSER_OBSERVE, { sessionId, browserId }) as BrowserObserveResult
      expect(observed.status).toBe('applied')
      samplesD.push(await sampleTree('D', index))
    }
    const privateC = median(samplesC.map((row) => row.sumPrivateMiB))
    const privateD = median(samplesD.map((row) => row.sumPrivateMiB))
    const deltaDC = privateD - privateC

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
      budget: { privateDeltaDCMiB: DC_BUDGET_MIB },
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
        C: { medianPrivateMiB: privateC, samples: samplesC },
        D: { medianPrivateMiB: privateD, samples: samplesD },
        deltaDCMiB: deltaDC
      },
      note: 'C=已打开页面、尚未观察；D=每次采样前先观察一次，使调试器与隔离世界仍附着。超过 40 MiB 只记录归因、不改预算。'
    }
    const reportDir = path.resolve(
      __dirname,
      '../../../docs/Local_Docs/评估报告/2026-09-22-浏览器观察附加内存'
    )
    await mkdir(reportDir, { recursive: true })
    await writeFile(path.join(reportDir, 'raw.json'), `${JSON.stringify(dump, null, 2)}\n`, 'utf8')
    await test.info().attach('browser-observe-extra-memory.json', {
      body: Buffer.from(JSON.stringify(dump, null, 2)),
      contentType: 'application/json'
    })
    console.log(
      `observe-extra-memory: D-C=${deltaDC.toFixed(2)} MiB C=${privateC.toFixed(2)} D=${privateD.toFixed(2)} budget=${DC_BUDGET_MIB}`
    )
    expect(deltaDC, `D-C ${deltaDC.toFixed(2)} MiB 超过 ${DC_BUDGET_MIB} MiB，预算不放宽`).toBeLessThanOrEqual(DC_BUDGET_MIB)
  } finally {
    await fixture.close()
  }
})
