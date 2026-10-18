import { expect, launchNova, test } from '../fixtures/nova'

test('缓存命中统计在切换会话、页面重载和重启后保留，并继续累计', async ({}, testInfo) => {
  let nova = await launchNova(testInfo)
  const enqueueUsage = (cached: number, text: string) => nova.provider.enqueue({
    kind: 'raw', events: [
      { payload: { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] } },
      { payload: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: {
        prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010,
        prompt_tokens_details: { cached_tokens: cached }
      } } },
      { payload: '[DONE]' }
    ]
  })
  const expectRate = async (text: string) => {
    await nova.page.locator('.context-indicator').hover()
    await expect(nova.page.locator('.context-usage__summary')).toHaveText(text)
    await nova.page.getByLabel('消息输入').hover()
  }
  try {
    const first = (await nova.getWorkspace()).currentSessionId
    if (!first) throw new Error('Missing session')
    enqueueUsage(800, 'CACHE_FIRST_READY')
    await nova.sendPrompt('第一轮缓存统计')
    await nova.waitUntilIdle()
    await expectRate('80.0%')
    await nova.createSession()
    await expectRate('未报告')
    await nova.selectSession(first)
    await expectRate('80.0%')
    await nova.page.reload()
    await expect(nova.page.getByLabel('消息输入')).toBeEditable()
    await expectRate('80.0%')
    await nova.app.close()
    nova = await launchNova(testInfo, { skipWorkspaceSetup: true }, nova)
    await expectRate('80.0%')
    enqueueUsage(200, 'CACHE_SECOND_READY')
    await nova.sendPrompt('第二轮缓存统计')
    await nova.waitUntilIdle()
    await expectRate('50.0%')
    nova.provider.enqueue({ kind: 'hold', id: 'background-usage', text: 'CACHE_BACKGROUND_READY',
      usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 800 } } })
    await nova.sendPrompt('后台继续累计')
    await nova.provider.waitForRequestCount(3)
    await nova.createSession()
    nova.provider.release('background-usage')
    await expect.poll(async () => (await nova.getRunSnapshot(first))?.status).toBe('completed')
    await expectRate('未报告')
    await nova.selectSession(first)
    await expectRate('60.0%')
    expect(nova.pageErrors).toEqual([])
  } finally {
    await nova.cleanup()
  }
})
