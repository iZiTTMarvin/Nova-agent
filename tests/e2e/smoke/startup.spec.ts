import { expect, test } from '../fixtures/nova'

test('会话准备完成后，preload 与 workspace IPC 指向本次隔离工作区', async ({ nova }) => {
  const workspace = await nova.getWorkspace()

  expect(workspace.currentProjectPath).toBe(nova.workspacePath)
  expect(workspace.currentSessionId).not.toBeNull()
  await expect(nova.page.getByLabel('消息输入')).toBeVisible()
  await expect(nova.page.getByLabel('消息输入')).toBeEditable()
  expect(nova.pageErrors).toEqual([])
})
