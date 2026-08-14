import { expect, test } from '../fixtures/nova'

test('迟到的旧 snapshot 不能把已完成 run 回退为 running', async ({ nova }) => {
  nova.provider.enqueue({ kind: 'text', text: 'NOVA_E2E_ORDER_OK' })

  await nova.sendPrompt('完成后注入旧 sequence')
  await expect(nova.page.getByText('NOVA_E2E_ORDER_OK', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()

  const completed = await nova.getRunSnapshot()
  if (!completed) throw new Error('completed snapshot missing')

  const staleSequence = Math.max(0, completed.sequence - 1)
  await nova.emitRunSnapshot(
    {
      ...completed,
      status: 'running',
      sequence: staleSequence,
      updatedAt: Math.max(0, completed.updatedAt - 1)
    },
    {
      sequence: staleSequence,
      type: 'e2e_stale_snapshot',
      at: Date.now()
    }
  )

  await nova.waitUntilIdle()
  await expect(nova.page.getByRole('button', { name: '中断生成' })).toHaveCount(0)
  expect((await nova.getRunSnapshot())?.status).toBe('completed')
})
