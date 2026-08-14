import { expect, test } from '../fixtures/nova'

test('向 Renderer 重复投递终态 run:snapshot 后，终态消息仍只渲染一次', async ({ nova }) => {
  const completed = await nova.runTurnToCompletion({
    text: 'NOVA_E2E_DUPLICATE_ONCE',
    prompt: '完成后向 Renderer 注入重复 snapshot'
  })

  await nova.emitRunSnapshot({
    snapshot: completed,
    event: {
      sequence: completed.sequence,
      type: 'e2e_duplicate_snapshot',
      at: Date.now()
    }
  })

  await nova.waitUntilIdle()
  await expect(nova.page.getByText('NOVA_E2E_DUPLICATE_ONCE', { exact: false })).toHaveCount(1)
  expect((await nova.getRunSnapshot())?.status).toBe('completed')
})
