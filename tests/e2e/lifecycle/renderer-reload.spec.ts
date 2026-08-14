import { expect, test } from '../fixtures/nova'

test('Renderer reload 后从权威 snapshot 恢复正在运行的会话并正确收尾', async ({ nova }) => {
  nova.provider.enqueue({
    kind: 'hold',
    id: 'reload-run',
    text: 'NOVA_E2E_RELOAD_OK'
  })

  await nova.sendPrompt('运行中重载 renderer')
  await expect(nova.page.getByRole('button', { name: '中断生成' })).toBeVisible()

  await nova.page.reload()
  await expect(nova.page.getByLabel('消息输入')).toBeVisible()
  await expect(nova.page.getByRole('button', { name: '中断生成' })).toBeVisible()

  nova.provider.release('reload-run')

  await expect(nova.page.getByText('NOVA_E2E_RELOAD_OK', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()
  expect((await nova.getRunSnapshot())?.status).toBe('completed')
})
