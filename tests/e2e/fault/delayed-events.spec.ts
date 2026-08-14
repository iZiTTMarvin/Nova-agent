import { expect, test } from '../fixtures/nova'

test('HTTP 分块延迟流走完真实链路后，Renderer 能回到可输入状态', async ({ nova }) => {
  nova.provider.enqueue({
    kind: 'text',
    text: 'NOVA_E2E_DELAYED_OK',
    chunks: ['NOVA_E2E_', 'DELAYED_', 'OK'],
    chunkDelayMs: 250
  })

  await nova.sendPrompt('用延迟流返回结果')
  await expect(nova.page.getByRole('button', { name: '中断生成' })).toBeVisible()
  await expect(nova.page.getByText('NOVA_E2E_DELAYED_OK', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()
  expect((await nova.getRunSnapshot())?.status).toBe('completed')
})

test('向 Renderer 注入带 sequence 缺口的 running 快照后，投影不会卡在生成中', async ({ nova }) => {
  const completed = await nova.runTurnToCompletion({
    text: 'NOVA_E2E_SEQUENCE_GAP_OK',
    prompt: '完成后向 Renderer 注入缺口 snapshot'
  })

  await nova.emitRunSnapshot({
    snapshot: {
      ...completed,
      status: 'running',
      sequence: completed.sequence + 2,
      updatedAt: Date.now()
    },
    event: {
      sequence: completed.sequence + 2,
      type: 'e2e_sequence_gap',
      at: Date.now()
    }
  })

  await nova.waitUntilIdle()
  await expect(nova.page.getByRole('button', { name: '中断生成' })).toHaveCount(0)
  expect((await nova.getRunSnapshot())?.status).toBe('completed')
})
