import { expect, test } from '../fixtures/nova'

test('多次 Renderer 重建不会累积重复 IPC 监听或重复渲染终态消息', async ({ nova }) => {
  nova.provider.enqueue({
    kind: 'hold',
    id: 'remount-run',
    text: 'NOVA_E2E_REMOUNT_ONCE'
  })

  await nova.sendPrompt('多次重建 renderer 后只处理一次结果')
  await expect(nova.page.getByRole('button', { name: '中断生成' })).toBeVisible()

  for (let index = 0; index < 2; index++) {
    await nova.page.reload()
    await expect(nova.page.getByLabel('消息输入')).toBeVisible()
    await expect(nova.page.getByRole('button', { name: '中断生成' })).toBeVisible()
  }

  nova.provider.release('remount-run')
  await expect(nova.page.getByText('NOVA_E2E_REMOUNT_ONCE', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()

  await expect(nova.page.getByText('NOVA_E2E_REMOUNT_ONCE', { exact: false })).toHaveCount(1)
  expect(nova.pageErrors).toEqual([])
})
