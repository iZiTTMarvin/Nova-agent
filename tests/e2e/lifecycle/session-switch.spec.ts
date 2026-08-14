import { expect, test } from '../fixtures/nova'
import { isTerminalRunStatus } from '../../../src/shared/run/types'

test('旧会话迟到完成后，当前会话不会被旧结果污染', async ({ nova }) => {
  nova.provider.enqueue({
    kind: 'hold',
    id: 'old-session-run',
    text: 'OLD_SESSION_LATE_RESULT'
  })

  const before = await nova.getWorkspace()
  const oldSessionId = before.currentSessionId
  expect(oldSessionId).not.toBeNull()
  if (!oldSessionId) throw new Error('old session id missing')

  await nova.sendPrompt('在旧会话中保持运行')
  await expect(nova.page.getByRole('button', { name: '中断生成' })).toBeVisible()

  const next = await nova.createSession()
  expect(next.currentSessionId).not.toBe(oldSessionId)
  await expect(nova.page.getByLabel('消息输入')).toBeEditable()

  nova.provider.release('old-session-run')
  await expect.poll(async () => {
    const snapshot = await nova.getRunSnapshot(oldSessionId)
    return snapshot != null && isTerminalRunStatus(snapshot.status)
  }).toBe(true)

  expect((await nova.getWorkspace()).currentSessionId).toBe(next.currentSessionId)
  await expect(nova.page.getByText('OLD_SESSION_LATE_RESULT', { exact: false })).toHaveCount(0)
  await expect(nova.page.getByLabel('消息输入')).toBeEditable()
})
