import { expect, test } from '../fixtures/nova'

test('启动后真实 preload 与 workspace IPC 可用', async ({ nova }) => {
  const workspace = await nova.getWorkspace()

  expect(workspace.currentProjectPath).toBe(nova.workspacePath)
  expect(workspace.currentSessionId).not.toBeNull()
  await expect(nova.page.getByLabel('消息输入')).toBeVisible()
  await expect(nova.page.getByLabel('消息输入')).toBeEditable()
  expect(nova.pageErrors).toEqual([])
})
