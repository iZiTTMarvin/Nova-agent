import { expect, test } from '../fixtures/nova'

test('provider 失败后 run 明确失败且用户可以继续输入', async ({ nova }) => {
  nova.provider.enqueue({
    kind: 'error',
    status: 400,
    body: { error: { message: 'NOVA_E2E_PROVIDER_FAILURE' } }
  })

  await nova.sendPrompt('触发可控 provider 失败')

  await expect.poll(async () => (await nova.getRunSnapshot())?.status, { timeout: 15_000 }).toBe('failed')
  await nova.waitUntilIdle()
  await expect(nova.page.getByLabel('消息输入')).toBeEditable()
})
