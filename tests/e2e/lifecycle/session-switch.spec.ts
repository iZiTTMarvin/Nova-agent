import { expect, test } from '../fixtures/nova'
import { isTerminalRunStatus } from '../../../src/shared/run/types'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

test('读取旧会话详情不会改变当前选择或重新进入加载状态', async ({ nova }) => {
  nova.provider.enqueue({ kind: 'text', text: 'FIRST_SESSION_READY' })
  await nova.sendPrompt('保留第一条会话')
  await nova.waitUntilIdle()
  const old = await nova.getWorkspace()
  if (!old.currentSessionId) throw new Error('session id missing')
  const current = await nova.createSession()
  expect(current.currentSessionId).not.toBe(old.currentSessionId)
  await nova.invoke('load-session', { sessionId: old.currentSessionId })
  expect((await nova.getWorkspace()).currentSessionId).toBe(current.currentSessionId)
  await expect(nova.page.locator('.chat-session-loading')).toHaveCount(0)
  await expect(nova.page.getByLabel('消息输入')).toBeEditable()
})

test('记忆计数跟随会话投影，菜单选择持久化且下轮排除工具和快照', async ({ nova }) => {
  await nova.invoke('settings:set', { memoryEnabled: true })
  await nova.invoke('memory:write-file', { scopeKind: 'project', relPath: 'conventions.md', content: '<!-- nova-memory v1 -->\n- Always check release notes before publishing\n' })
  nova.provider.enqueue({ kind: 'text', text: 'MEMORY_FIRST_READY' })
  await nova.sendPrompt('第一轮记忆投影')
  await nova.waitUntilIdle()
  const first = (await nova.getWorkspace()).currentSessionId
  if (!first) throw new Error('missing first session')
  const summary = (await nova.getWorkspace()).availableSessions.find(session => session.id === first)
  expect(summary?.memorySnapshot).toEqual(expect.objectContaining({ globalCoreCount: 0, projectCoreCount: 1 }))
  await expect(nova.page.getByRole('button', { name: '已加载 1 条记忆', exact: true })).toBeVisible()
  expect(JSON.stringify(summary)).not.toContain('Always check release notes')
  await nova.page.getByRole('button', { name: '已加载 1 条记忆', exact: true }).click()
  await expect(nova.page.getByText('开局记忆预览', { exact: true })).toBeVisible()
  await nova.page.getByRole('button', { name: '返回应用', exact: true }).click()
  await nova.page.getByRole('button', { name: '当前会话操作', exact: true }).click()
  await nova.page.getByRole('menuitem', { name: '本会话不记忆', exact: true }).click()
  await expect.poll(async () => (await nova.getWorkspace()).availableSessions.find(session => session.id === first)?.memoryOptOut).toBe(true)
  await expect(nova.page.getByRole('button', { name: '已加载 1 条记忆', exact: true })).toHaveCount(0)
  nova.provider.enqueue({ kind: 'text', text: 'MEMORY_PRIVATE_READY' })
  await nova.sendPrompt('私密内容不应写入记忆')
  await nova.waitUntilIdle()
  const wire = nova.provider.requests.at(-1)?.body
  expect(JSON.stringify(wire?.tools)).not.toMatch(/memory_(read|search|manage)/)
  const system = Array.isArray(wire?.messages) ? wire.messages.filter((message: { role?: string }) => message.role === 'system') : []
  expect(JSON.stringify(system)).not.toContain('Always check release notes')
  await nova.createSession()
  await expect(nova.page.getByRole('button', { name: /^已加载 \d+ 条记忆$/ })).toHaveCount(0)
  await nova.selectSession(first)
  await nova.page.reload()
  await expect(nova.page.getByLabel('消息输入')).toBeEditable()
  expect((await nova.getWorkspace()).availableSessions.find(session => session.id === first)?.memoryOptOut).toBe(true)
  expect(JSON.parse(await readFile(path.join(nova.profileRoot, 'userData', 'sessions', first, 'session.json'), 'utf8')).memoryOptOut).toBe(true)
  await expect(nova.invoke('session:set-memory-opt-out', { sessionId: 'missing', optOut: true })).rejects.toThrow('主会话不存在')
  expect(nova.pageErrors).toEqual([])
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
