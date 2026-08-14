import { expect, test } from '../fixtures/nova'

test('向 Renderer 注入更旧 sequence 的 running 快照后，投影不会从已完成回退为生成中', async ({ nova }) => {
  const completed = await nova.runTurnToCompletion({
    text: 'NOVA_E2E_ORDER_OK',
    prompt: '完成后向 Renderer 注入旧 sequence'
  })

  const staleSequence = Math.max(0, completed.sequence - 1)
  await nova.emitRunSnapshot({
    snapshot: {
      ...completed,
      status: 'running',
      sequence: staleSequence,
      updatedAt: Math.max(0, completed.updatedAt - 1)
    },
    event: {
      sequence: staleSequence,
      type: 'e2e_stale_snapshot',
      at: Date.now()
    }
  })

  await nova.waitUntilIdle()
  await expect(nova.page.getByRole('button', { name: '中断生成' })).toHaveCount(0)
  expect((await nova.getRunSnapshot())?.status).toBe('completed')
})
