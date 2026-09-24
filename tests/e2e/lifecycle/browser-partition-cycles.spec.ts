import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test } from '../fixtures/nova'
import { BROWSER_CLOSE, BROWSER_NAVIGATE, BROWSER_OPEN } from '../../../src/shared/ipc/channels'
import { BROWSER_PARTITION_SLOT_NAMES } from '../../../src/main/browser/partitionSlots'

const CYCLES = 30
const PRIVATE_BUDGET_MIB = 10

interface TypeBucket {
  count: number
  privateMiB: number
  workingSetMiB: number
}

interface TreeSample {
  cycle: number
  processCount: number
  sumPrivateMiB: number
  sumWorkingSetMiB: number
  byType: Record<string, TypeBucket>
}

async function startGuestFixture(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>slot</title><body>slot</body>')
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

test('三十次打开刷新关闭后进程树不增生，并采样私有内存', async ({ nova }) => {
  test.setTimeout(180_000)
  const fixture = await startGuestFixture()
  const samples: TreeSample[] = []
  const guest = nova.page.locator('webview[data-browser-id]')
  try {
    const workspace = await nova.getWorkspace()
    const sessionId = workspace.currentSessionId
    expect(sessionId).toBeTruthy()

    const sampleTree = (cycle: number): Promise<TreeSample> =>
      nova.app.evaluate(({ app }, cycleIndex) => {
        const rows = app.getAppMetrics()
        const byType: Record<string, { count: number; privateMiB: number; workingSetMiB: number }> = {}
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
          cycle: cycleIndex,
          processCount: rows.length,
          sumPrivateMiB,
          sumWorkingSetMiB,
          byType
        }
      }, cycle)

    for (let index = 0; index < CYCLES; index += 1) {
      const opened = await nova.invoke(BROWSER_OPEN, {
        sessionId: sessionId!,
        url: fixture.url
      })
      expect(opened.status).toBe('applied')
      if (opened.status !== 'applied') return

      await expect(guest).toHaveCount(1)
      expect(BROWSER_PARTITION_SLOT_NAMES).toContain(await guest.getAttribute('partition'))

      const reloaded = await nova.invoke(BROWSER_NAVIGATE, {
        sessionId: sessionId!,
        browserId: opened.page.browserId,
        action: { kind: 'reload' }
      })
      expect(reloaded.status).toBe('applied')

      const closed = await nova.invoke(BROWSER_CLOSE, {
        sessionId: sessionId!,
        browserId: opened.page.browserId
      })
      expect(closed.status).toBe('applied')
      await expect(guest).toHaveCount(0)
      samples.push(await sampleTree(index))
    }

    const first10 = samples.slice(0, 10).map((row) => row.sumPrivateMiB)
    const last10 = samples.slice(-10).map((row) => row.sumPrivateMiB)
    const delta = median(last10) - median(first10)
    const firstTypes = samples[0]?.byType ?? {}
    const lastTypes = samples.at(-1)?.byType ?? {}
    const typeKeys = [...new Set([...Object.keys(firstTypes), ...Object.keys(lastTypes)])].sort()
    const typeDelta = typeKeys.map((key) => {
      const first = firstTypes[key]?.privateMiB ?? 0
      const last = lastTypes[key]?.privateMiB ?? 0
      return `${key} ${first.toFixed(2)}→${last.toFixed(2)} (${(last - first).toFixed(2)})`
    })

    const dump = {
      budgetMiB: PRIVATE_BUDGET_MIB,
      first10MedianPrivateMiB: median(first10),
      last10MedianPrivateMiB: median(last10),
      deltaLastMinusFirstMiB: delta,
      rawFirst10: first10,
      rawLast10: last10,
      processCounts: samples.map((row) => row.processCount),
      lastByType: lastTypes,
      samples
    }
    await test.info().attach('browser-partition-cycles.json', {
      body: Buffer.from(JSON.stringify(dump, null, 2)),
      contentType: 'application/json'
    })
    console.log(
      `partition-cycles: delta=${delta.toFixed(2)} MiB first10=${median(first10).toFixed(2)} last10=${median(last10).toFixed(2)} types=${typeDelta.join('; ')}`
    )

    // 预算 10 MiB：超限不改口径放行，只把分类型实测写进错误信息供清单记录。
    expect(
      delta,
      `私有内存中位数增长 ${delta.toFixed(2)} MiB（前十 ${median(first10).toFixed(2)} → 后十 ${median(last10).toFixed(2)}；工作集末次 ${samples.at(-1)?.sumWorkingSetMiB.toFixed(2)} MiB；进程数 ${samples.map((row) => row.processCount).join(',') }；分类型 ${typeDelta.join('; ')}）`
    ).toBeLessThanOrEqual(PRIVATE_BUDGET_MIB)
  } finally {
    await fixture.close()
  }
})
