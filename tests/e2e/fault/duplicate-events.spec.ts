import { expect, test } from '../fixtures/nova'

test('重复 run snapshot 不会重复提交 UI 状态或终态消息', async ({ nova }) => {
  nova.provider.enqueue({ kind: 'text', text: 'NOVA_E2E_DUPLICATE_ONCE' })

  await nova.sendPrompt('完成后注入重复 snapshot')
  await expect(nova.page.getByText('NOVA_E2E_DUPLICATE_ONCE', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()

  const completed = await nova.getRunSnapshot()
  if (!completed) throw new Error('completed snapshot missing')

  await nova.emitRunSnapshot(completed, {
    sequence: completed.sequence,
    type: 'e2e_duplicate_snapshot',
    at: Date.now()
  })

  await nova.waitUntilIdle()
  await expect(nova.page.getByText('NOVA_E2E_DUPLICATE_ONCE', { exact: false })).toHaveCount(1)
  expect((await nova.getRunSnapshot())?.status).toBe('completed')
})
