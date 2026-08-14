import { expect, test } from '../fixtures/nova'

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

test('@stress 固定 seed 的连续发送、reload 与 cancel 后始终能回到可交互状态', async ({ nova }) => {
  test.setTimeout(120_000)

  const seed = 0x4e4f5641
  const random = createSeededRandom(seed)

  for (let index = 0; index < 15; index++) {
    const value = random()

    if (value < 0.2) {
      const holdId = `stress-abort-${index}`
      nova.provider.enqueue({ kind: 'hold', id: holdId, text: `STRESS_ABORT_SHOULD_NOT_RENDER_${index}` })
      await nova.sendPrompt(`stress abort ${index}; seed=${seed}`)
      await expect(nova.page.getByRole('button', { name: '中断生成' })).toBeVisible()
      const abortedBefore = nova.provider.requests.filter(request => request.aborted).length
      await nova.page.getByRole('button', { name: '中断生成' }).click()
      await nova.provider.waitForAbortCount(abortedBefore + 1, 10_000)
      await expect.poll(async () => (await nova.getRunSnapshot())?.status).toBe('cancelled')
      await nova.waitUntilIdle()
      continue
    }

    const marker = `NOVA_E2E_STRESS_${index}`

    if (value < 0.35) {
      const holdId = `stress-reload-${index}`
      nova.provider.enqueue({ kind: 'hold', id: holdId, text: marker })
      await nova.sendPrompt(`stress normal ${index}; seed=${seed}`)
      await expect(nova.page.getByRole('button', { name: '中断生成' })).toBeVisible()
      await nova.page.reload()
      await expect(nova.page.getByLabel('消息输入')).toBeVisible()
      await expect(nova.page.getByRole('button', { name: '中断生成' })).toBeVisible()
      nova.provider.release(holdId)
    } else {
      nova.provider.enqueue({
        kind: 'text',
        text: marker,
        chunks: ['NOVA_E2E_', `STRESS_${index}`],
        chunkDelayMs: value < 0.45 ? 30 : undefined
      })
      await nova.sendPrompt(`stress normal ${index}; seed=${seed}`)
    }

    await expect(nova.page.getByText(marker, { exact: false })).toBeVisible()
    await nova.waitUntilIdle()
  }

  expect(nova.pageErrors, `seed=${seed}`).toEqual([])
  await expect(nova.page.getByLabel('消息输入')).toBeEditable()
})
