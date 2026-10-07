import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '../fixtures/nova'

test('新会话按钮和快捷键复用草稿，首发后才出现历史，reload 保持同一 ID', async ({ nova }) => {
  const first = (await nova.getWorkspace()).currentSessionId
  if (!first) throw new Error('missing draft')
  const metadata = path.join(nova.profileRoot, 'userData', 'sessions', first, 'session.json')
  const input = nova.page.getByLabel('消息输入')
  await input.fill('保留尚未发送的草稿')
  const button = nova.page.getByRole('button', { name: /^新会话/ }).first()
  for (let index = 0; index < 8; index++) await button.click()
  await nova.page.keyboard.press('Control+n')
  await expect(input).toHaveText('保留尚未发送的草稿')
  await expect(input).toBeFocused()
  expect((await nova.getWorkspace()).currentSessionId).toBe(first)
  await expect(nova.page.locator('.sidebar-session-row')).toHaveCount(0)
  await expect(access(metadata)).rejects.toThrow()
  await nova.page.reload()
  await expect(input).toBeEditable()
  expect((await nova.getWorkspace()).currentSessionId).toBe(first)
  nova.provider.enqueue({ kind: 'text', text: 'DRAFT_COMMITTED' })
  await nova.sendPrompt('首条正式消息')
  await expect(nova.page.getByText('DRAFT_COMMITTED', { exact: true })).toBeVisible()
  await nova.waitUntilIdle()
  expect(JSON.parse(await readFile(metadata, 'utf8')).id).toBe(first)
  await expect(nova.page.locator('.sidebar-session-row')).toHaveCount(1)
  await button.click()
  const next = (await nova.getWorkspace()).currentSessionId
  expect(next).not.toBe(first)
  await expect(nova.page.locator('.sidebar-session-row')).toHaveCount(1)
  await input.fill('第二份草稿')
  await nova.selectSession(first)
  await expect(nova.page.getByText('DRAFT_COMMITTED', { exact: true })).toBeVisible()
  await button.click()
  expect((await nova.getWorkspace()).currentSessionId).toBe(next)
  await expect(input).toHaveText('第二份草稿')
  expect(nova.pageErrors).toEqual([])
})

test('首发无效指令保留草稿且不创建历史，学习与开发草稿相互隔离', async ({ nova }) => {
  const first = (await nova.getWorkspace()).currentSessionId
  if (!first) throw new Error('missing draft')
  const input = nova.page.getByLabel('消息输入')
  await nova.sendPrompt('/nonexistent-draft-regression')
  await expect(input).toHaveText('/nonexistent-draft-regression')
  await expect(nova.page.locator('.sidebar-session-row')).toHaveCount(0)
  expect(nova.provider.requests).toHaveLength(0)
  const learn = await nova.createSession('learn')
  expect(learn.currentSessionId).not.toBe(first)
  expect((await nova.createSession('learn')).currentSessionId).toBe(learn.currentSessionId)
  expect((await nova.createSession('default')).currentSessionId).toBe(first)
  await expect(input).toHaveText('/nonexistent-draft-regression')
  expect(nova.pageErrors).toEqual([])
})

test('草稿图片在重复点击和切面后保留，拒发可恢复，纯图片首发也进入历史', async ({ nova }) => {
  await nova.invoke('save-model-config', {
    baseUrl: nova.provider.baseUrl, apiKey: 'nova-e2e-key', modelId: 'nova-e2e-model',
    cacheProfile: 'generic', toolDialect: 'native', supportsVision: true
  })
  await nova.page.reload()
  await expect(nova.page.getByLabel('消息输入')).toBeEditable()
  const first = (await nova.getWorkspace()).currentSessionId
  if (!first) throw new Error('missing draft')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYZkAAAAASUVORK5CYII=', 'base64')
  await nova.page.locator('input[type="file"]').setInputFiles({ name: 'draft.png', mimeType: 'image/png', buffer: png })
  const preview = nova.page.locator('.image-preview-bar__item')
  await expect(preview).toHaveCount(1)
  await nova.createSession()
  await expect(preview).toHaveCount(1)
  await nova.createSession('learn')
  await nova.createSession('default')
  await expect(preview).toHaveCount(1)
  const registry = await nova.invoke('load-llm-registry')
  if (!registry) throw new Error('missing registry')
  for (const provider of registry.providers) {
    for (const model of provider.models) model.supportsVision = false
  }
  await nova.invoke('save-llm-registry', registry)
  await nova.sendPrompt('图片首发被拒后应保留')
  await expect(nova.page.getByLabel('消息输入')).toHaveText('图片首发被拒后应保留')
  await expect(preview).toHaveCount(1)
  await expect(nova.page.locator('.sidebar-session-row')).toHaveCount(0)
  expect(await nova.invoke('load-session', { sessionId: first })).toMatchObject({ isDraft: true })
  for (const provider of registry.providers) {
    for (const model of provider.models) model.supportsVision = true
  }
  await nova.invoke('save-llm-registry', registry)
  await nova.page.getByLabel('消息输入').fill('')
  nova.provider.enqueue({ kind: 'text', text: 'IMAGE_ONLY_COMMITTED' })
  await nova.page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(nova.page.getByText('IMAGE_ONLY_COMMITTED', { exact: true })).toBeVisible()
  await nova.waitUntilIdle()
  await expect(preview).toHaveCount(0)
  await expect(nova.page.locator('.sidebar-session-row')).toHaveCount(1)
  const disk = await readFile(path.join(nova.profileRoot, 'userData', 'sessions', first, 'messages.jsonl'), 'utf8')
  expect(disk).toContain(`nova-image://${first}/`)
  expect(nova.provider.requests).toHaveLength(1)
  expect(nova.pageErrors).toEqual([])
})
