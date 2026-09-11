import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { SAVE_MODEL_CONFIG } from '../../../src/shared/ipc/channels'
import { expect, launchNova, test } from '../fixtures/nova'

test('长历史在本轮投影后压缩提交，主请求恢复并可重启续聊', async ({}, testInfo) => {
  let nova = await launchNova(testInfo)
  try {
    await nova.invoke(SAVE_MODEL_CONFIG, {
      baseUrl: nova.provider.baseUrl, apiKey: 'nova-e2e-key', modelId: 'MiniMax-M3',
      contextWindow: 40_000, cacheProfile: 'minimax', toolDialect: 'native'
    })
    const session = await nova.createSession('default')
    nova.provider.enqueue({ kind: 'text', text: 'history '.repeat(20_000) })
    await nova.sendPrompt('分析当前任务')
    await nova.waitUntilIdle()
    expect(nova.provider.requests).toHaveLength(1)
    const state = JSON.stringify({ schemaVersion: 1, goal: '继续分析', nextActions: '继续回复用户',
      keyContext: '历史讨论已整理', progress: '已分析历史', decisions: '继续当前任务', facts: [] })
    nova.provider.enqueue({ kind: 'text', text: state }, { kind: 'text', text: state }, {
      kind: 'raw', events: [
        { payload: { choices: [{ index: 0, delta: { content: 'COMPACTION_MAIN_OK' }, finish_reason: null }] } },
        { payload: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1234, completion_tokens: 4, total_tokens: 1238 } } }
      ]
    })
    await nova.sendPrompt('继续分析')
    await expect(nova.page.getByText('COMPACTION_MAIN_OK', { exact: false })).toBeVisible()
    await nova.waitUntilIdle()
    expect(nova.provider.requests).toHaveLength(4)
    const snapshotPath = path.join(nova.profileRoot, 'userData', 'sessions', session.currentSessionId!, 'context-snapshot.json')
    const ledger = JSON.parse(await readFile(snapshotPath, 'utf8'))
    expect(ledger.entries).toHaveLength(1)
    expect(ledger.budgetAnchor.inputTokens).toBe(1234)
    expect(ledger.budgetAnchor.estimatorVersion).toBe(5)
    const compactedRequest = nova.provider.requests[3].body
    await nova.app.close()
    nova = await launchNova(testInfo, { skipWorkspaceSetup: true }, nova)
    nova.provider.enqueue({ kind: 'text', text: 'COMPACTION_RESTART_OK' })
    await nova.sendPrompt('继续')
    await expect(nova.page.getByText('COMPACTION_RESTART_OK', { exact: false })).toBeVisible()
    await nova.waitUntilIdle()
    expect(nova.provider.requests).toHaveLength(5)
    const resumed = nova.provider.requests[4].body
    if (!Array.isArray(compactedRequest.messages) || !Array.isArray(resumed.messages)) throw new Error('Missing wire messages')
    expect(resumed.messages.slice(0, compactedRequest.messages.length)).toEqual(compactedRequest.messages)
    expect(nova.pageErrors).toEqual([])
  } finally {
    await nova.cleanup()
  }
})
