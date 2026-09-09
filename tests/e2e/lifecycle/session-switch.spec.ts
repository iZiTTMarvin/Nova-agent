import { expect, test } from '../fixtures/nova'
import { isTerminalRunStatus } from '../../../src/shared/run/types'

test('读取旧会话详情不会改变当前选择或重新进入加载状态', async ({ nova }) => {
  const old = await nova.getWorkspace()
  if (!old.currentSessionId) throw new Error('session id missing')
  const current = await nova.createSession()
  await nova.invoke('load-session', { sessionId: old.currentSessionId })
  expect((await nova.getWorkspace()).currentSessionId).toBe(current.currentSessionId)
  await expect(nova.page.locator('.chat-session-loading')).toHaveCount(0)
  await expect(nova.page.getByLabel('消息输入')).toBeEditable()
})

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

test('两个会话并发时，后台读取和结束不改变前台焦点或停止目标', async ({ nova }) => {
  const first = (await nova.getWorkspace()).currentSessionId
  if (!first) throw new Error('first session id missing')
  nova.provider.enqueue({ kind: 'hold', id: 'concurrent-a', text: 'CONCURRENT_A_DONE' })
  await nova.sendPrompt('保持会话 A 运行')
  await nova.provider.waitForRequestCount(1)
  const second = (await nova.createSession()).currentSessionId
  if (!second) throw new Error('second session id missing')
  nova.provider.enqueue({ kind: 'hold', id: 'concurrent-b', text: 'CONCURRENT_B_DONE' })
  await nova.sendPrompt('保持会话 B 运行')
  await nova.provider.waitForRequestCount(2)
  expect((await nova.getRunSnapshot(first))?.status).toBe('running')
  expect((await nova.getRunSnapshot(second))?.status).toBe('running')
  expect((await nova.getWorkspace()).currentSessionId).toBe(second)

  nova.provider.release('concurrent-a')
  await expect.poll(async () => (await nova.getRunSnapshot(first))?.status).toBe('completed')
  await expect(nova.page.getByRole('button', { name: '中断生成' })).toBeVisible()
  expect((await nova.getWorkspace()).currentSessionId).toBe(second)
  expect((await nova.getRunSnapshot(second))?.status).toBe('running')
  await expect(nova.page.getByText('CONCURRENT_A_DONE', { exact: false })).toHaveCount(0)

  await nova.page.getByRole('button', { name: '中断生成' }).click()
  await nova.waitUntilIdle()
  expect((await nova.getRunSnapshot(first))?.status).toBe('completed')
  expect((await nova.getRunSnapshot(second))?.status).toBe('cancelled')
})
