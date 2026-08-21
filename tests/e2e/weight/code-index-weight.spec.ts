import { setTimeout as delay } from 'node:timers/promises'
import { expect, launchNova, test, type NovaHarness } from '../fixtures/nova'
import {
  CODEINDEX_GET_STATUS,
  SAVE_MODEL_CONFIG,
  SETTINGS_SET,
  WORKSPACE_SELECT_PROJECT
} from '../../../src/shared/ipc/channels'
import { CODE_INDEX_WORKER_IDLE_TIMEOUT_MS } from '../../../src/runtime/code-graph/worker/protocol'

const MIB = 1024 * 1024
const WORKER_RELEASE_TIMEOUT_MS = CODE_INDEX_WORKER_IDLE_TIMEOUT_MS + 15_000

async function mainPrivateBytes(nova: NovaHarness): Promise<number> {
  return nova.app.evaluate(async () => {
    const memory = await process.getProcessMemoryInfo()
    return memory.private * 1024
  })
}

async function mainCpuMicros(nova: NovaHarness): Promise<number> {
  return nova.app.evaluate(() => {
    const usage = process.cpuUsage()
    return usage.user + usage.system
  })
}

async function configure(nova: NovaHarness, codeIndexEnabled: boolean): Promise<void> {
  await nova.invoke(SAVE_MODEL_CONFIG, {
    baseUrl: nova.provider.baseUrl,
    apiKey: 'nova-e2e-key',
    modelId: 'nova-e2e-model',
    cacheProfile: 'generic',
    toolDialect: 'native'
  })
  await nova.invoke(SETTINGS_SET, { codeIndexEnabled })
}

test('代码索引运行重量保持在发布预算内', async ({}, testInfo) => {
  test.setTimeout(CODE_INDEX_WORKER_IDLE_TIMEOUT_MS + 240_000)
  const baseline = await launchNova(testInfo, {
    skipWorkspaceSetup: true,
    codeFileCount: 800
  })
  let baselineBase = 0
  let baselineWorkspace = 0
  try {
    await configure(baseline, false)
    await delay(500)
    baselineBase = await mainPrivateBytes(baseline)
    await baseline.invoke(WORKSPACE_SELECT_PROJECT, { path: baseline.workspacePath })
    await baseline.page.reload()
    await baseline.page.waitForFunction(() =>
      Boolean((window as typeof window & { api?: unknown }).api)
    )
    await delay(500)
    baselineWorkspace = await mainPrivateBytes(baseline)
    expect(await baseline.invoke(CODEINDEX_GET_STATUS)).toMatchObject({
      enabled: false,
      status: 'idle'
    })
  } finally {
    await baseline.cleanup()
  }

  const experiment = await launchNova(testInfo, {
    skipWorkspaceSetup: true,
    codeFileCount: 800
  })
  try {
    await configure(experiment, true)
    await delay(500)
    const experimentBase = await mainPrivateBytes(experiment)
    const samples: number[] = [experimentBase]
    let sampling = true
    const sampler = (async () => {
      while (sampling) {
        samples.push(await mainPrivateBytes(experiment))
        await delay(25)
      }
    })()

    await experiment.invoke(WORKSPACE_SELECT_PROJECT, { path: experiment.workspacePath })
    await experiment.page.reload()
    await experiment.page.waitForFunction(() =>
      Boolean((window as typeof window & { api?: unknown }).api)
    )
    await expect.poll(async () =>
      (await experiment.invoke(CODEINDEX_GET_STATUS)).status
    , { timeout: 120_000 }).toBe('ready')
    sampling = false
    await sampler

    await expect.poll(async () =>
      (await experiment.invoke(CODEINDEX_GET_STATUS)).workerState
    , { timeout: WORKER_RELEASE_TIMEOUT_MS }).toBe('stopped')
    const steady = await mainPrivateBytes(experiment)

    experiment.provider.enqueue(
      {
        kind: 'tool',
        name: 'code_context',
        arguments: { query: 'indexedSymbol42', intent: 'locate' }
      },
      { kind: 'text', text: 'NOVA_E2E_WEIGHT_QUERY_OK' }
    )
    await experiment.sendPrompt('查找 indexedSymbol42')
    await experiment.provider.waitForRequestCount(2)
    await experiment.waitUntilIdle()
    expect(JSON.stringify(experiment.provider.requests[1]?.body.messages))
      .toContain('module-42.ts')
    expect((await experiment.invoke(CODEINDEX_GET_STATUS)).workerState).toBe('stopped')
    const cpuStartedAt = await mainCpuMicros(experiment)
    const idleWindowStartedAt = Date.now()
    await delay(3_000)
    const idleWindowMs = Date.now() - idleWindowStartedAt
    const idleCpuPercent = (
      (await mainCpuMicros(experiment)) - cpuStartedAt
    ) / (idleWindowMs * 1000) * 100

    const baselineWorkspaceOverhead = Math.max(0, baselineWorkspace - baselineBase)
    const steadyDelta = Math.max(
      0,
      steady - experimentBase - baselineWorkspaceOverhead
    )
    const parsePeakDelta = Math.max(
      0,
      Math.max(...samples) - experimentBase - baselineWorkspaceOverhead
    )
    console.log('CODE_INDEX_WEIGHT', JSON.stringify({
      baseline_base_bytes: baselineBase,
      baseline_workspace_bytes: baselineWorkspace,
      experiment_base_bytes: experimentBase,
      experiment_steady_bytes: steady,
      steady_delta_bytes: steadyDelta,
      parse_peak_delta_bytes: parsePeakDelta,
      idle_cpu_percent: Math.round(idleCpuPercent * 1000) / 1000
    }))

    expect(steadyDelta).toBeLessThanOrEqual(20 * MIB)
    expect(parsePeakDelta).toBeLessThanOrEqual(150 * MIB)
    expect(idleCpuPercent).toBeLessThanOrEqual(5)
  } finally {
    await experiment.cleanup()
  }
})
