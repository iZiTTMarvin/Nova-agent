import { expect, test } from '../fixtures/nova'

test('流式请求中止后 run 进入终态且输入区恢复', async ({ nova }) => {
  nova.provider.enqueue({
    kind: 'hold',
    id: 'abort-run',
    text: 'SHOULD_NOT_RENDER'
  })

  await nova.sendPrompt('保持运行直到我停止')
  await expect(nova.page.getByRole('button', { name: '中断生成' })).toBeVisible()

  await nova.page.getByRole('button', { name: '中断生成' }).click()
  await nova.provider.waitForAbortCount(1, 10_000)
  await nova.waitUntilIdle()

  await expect.poll(async () => (await nova.getRunSnapshot())?.status).toBe('cancelled')
  await expect(nova.page.getByText('SHOULD_NOT_RENDER', { exact: false })).toHaveCount(0)
})
