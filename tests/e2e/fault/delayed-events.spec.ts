import { expect, test } from '../fixtures/nova'

test('延迟流和 sequence 缺口都不会让 Renderer 永久停在 running', async ({ nova }) => {
  nova.provider.enqueue({
    kind: 'text',
    text: 'NOVA_E2E_DELAYED_OK',
    chunks: ['NOVA_E2E_', 'DELAYED_', 'OK'],
    chunkDelayMs: 250
  })

  await nova.sendPrompt('用延迟流返回结果')
  await expect(nova.page.getByRole('button', { name: '中断生成' })).toBeVisible()
  await expect(nova.page.getByLabel('消息输入')).toBeEditable()
  await expect(nova.page.getByText('NOVA_E2E_DELAYED_OK', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()

  const completed = await nova.getRunSnapshot()
  expect(completed?.status).toBe('completed')
  if (!completed) throw new Error('completed snapshot missing')

  await nova.emitRunSnapshot(
    {
      ...completed,
      status: 'running',
      sequence: completed.sequence + 2,
      updatedAt: Date.now()
    },
    {
      sequence: completed.sequence + 2,
      type: 'e2e_sequence_gap',
      at: Date.now()
    }
  )

  await nova.waitUntilIdle()
  await expect.poll(async () => (await nova.getRunSnapshot())?.status).toBe('completed')
})
