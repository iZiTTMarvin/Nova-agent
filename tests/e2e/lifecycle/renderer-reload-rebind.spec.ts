import { expect, test } from '../fixtures/nova'

test('重复 Renderer reload 后 listener 重新绑定，终态消息仍只渲染一次', async ({ nova }) => {
  nova.provider.enqueue({
    kind: 'hold',
    id: 'reload-rebind-run',
    text: 'NOVA_E2E_RELOAD_REBIND_ONCE'
  })

  await nova.sendPrompt('多次 reload renderer 后只处理一次结果')
  await expect(nova.page.getByRole('button', { name: '中断生成' })).toBeVisible()

  for (let index = 0; index < 2; index++) {
    await nova.page.reload()
    await expect(nova.page.getByLabel('消息输入')).toBeVisible()
    await expect(nova.page.getByRole('button', { name: '中断生成' })).toBeVisible()
  }

  nova.provider.release('reload-rebind-run')
  await expect(nova.page.getByText('NOVA_E2E_RELOAD_REBIND_ONCE', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()

  await expect(nova.page.getByText('NOVA_E2E_RELOAD_REBIND_ONCE', { exact: false })).toHaveCount(1)
  expect(nova.pageErrors).toEqual([])
})
