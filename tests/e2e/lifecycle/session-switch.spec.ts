import { expect, test } from '../fixtures/nova'

test('旧会话仍有迟到结果时不能污染新会话', async ({ nova }) => {
  nova.provider.enqueue({
    kind: 'hold',
    id: 'old-session-run',
    text: 'OLD_SESSION_LATE_RESULT'
  })

  const before = await nova.getWorkspace()
  expect(before.currentSessionId).not.toBeNull()

  await nova.sendPrompt('在旧会话中保持运行')
  await expect(nova.page.getByRole('button', { name: '中断生成' })).toBeVisible()

  const next = await nova.createSession()
  expect(next.currentSessionId).not.toBe(before.currentSessionId)
  await expect(nova.page.getByLabel('消息输入')).toBeEditable()

  nova.provider.release('old-session-run')
  await nova.page.waitForTimeout(300)

  expect((await nova.getWorkspace()).currentSessionId).toBe(next.currentSessionId)
  await expect(nova.page.getByText('OLD_SESSION_LATE_RESULT', { exact: false })).toHaveCount(0)
  await expect(nova.page.getByLabel('消息输入')).toBeEditable()
})
