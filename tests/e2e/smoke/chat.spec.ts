import { expect, test } from '../fixtures/nova'

test('用户发送消息后完成真实 Electron 聊天链路并恢复可输入状态', async ({ nova }) => {
  nova.provider.enqueue({
    kind: 'text',
    text: 'NOVA_E2E_CHAT_OK',
    chunks: ['NOVA_', 'E2E_', 'CHAT_', 'OK']
  })

  await nova.sendPrompt('回复固定标记即可')
  await expect(nova.page.getByText('NOVA_E2E_CHAT_OK', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()

  const snapshot = await nova.getRunSnapshot()
  expect(snapshot?.status).toBe('completed')
  expect(nova.pageErrors).toEqual([])
})
