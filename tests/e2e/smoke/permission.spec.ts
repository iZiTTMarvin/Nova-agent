/**
 * 权限条关键路径 E2E
 *
 * 覆盖的回归：
 * - default 模式下 bash 触发内联权限条，允许后工具继续执行并完成整轮
 * - 子代理的权限请求锚定在父会话的子代理活动行（「子代理请求权限」），可直接回应
 */
import { expect, test } from '../fixtures/nova'

test('default 模式 bash 触发内联权限条，允许后继续完成整轮', async ({ nova }) => {
  const state = await nova.createSession('default')
  const sessionId = state.currentSessionId
  if (!sessionId) throw new Error('session id missing')

  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'bash',
      arguments: { command: 'echo nova_e2e_perm' },
      callId: 'call_bash_auth'
    },
    { kind: 'text', text: 'NOVA_E2E_AFTER_ALLOW' }
  )

  await nova.sendPrompt('执行需要授权的命令')
  await expect.poll(async () => (await nova.getRunSnapshot(sessionId))?.status)
    .toBe('waiting_user')

  // 内联权限条出现在工具行下，可允许 / 拒绝
  const permissionBar = nova.page.locator('.inline-perm')
  await expect(permissionBar).toBeVisible()
  await expect(permissionBar.getByRole('button', { name: '允许', exact: true })).toBeVisible()
  await expect(permissionBar.getByRole('button', { name: '拒绝', exact: true })).toBeVisible()

  // 允许后 bash 真实执行并继续整轮
  await permissionBar.getByRole('button', { name: '允许', exact: true }).click()
  await nova.provider.waitForRequestCount(2)
  await expect(nova.page.getByText('NOVA_E2E_AFTER_ALLOW', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()
  await expect(nova.page.locator('.inline-perm')).toHaveCount(0)
  expect((await nova.getRunSnapshot(sessionId))?.status).toBe('completed')

  expect(nova.pageErrors).toEqual([])
})

test('子代理权限请求锚定在父会话活动行并可回应', async ({ nova }) => {
  const state = await nova.createSession('default')
  const sessionId = state.currentSessionId
  if (!sessionId) throw new Error('session id missing')

  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'task',
      arguments: { subagent_type: 'code', task: '在工作区跑一条无害命令并把输出告诉我' },
      callId: 'call_task_spawn'
    },
    // 子代理第一轮直接请求 bash 权限
    {
      kind: 'tool',
      name: 'bash',
      arguments: { command: 'echo nova_e2e_subagent_perm' },
      callId: 'call_sub_bash'
    },
    { kind: 'text', text: 'NOVA_E2E_SUBAGENT_DONE' },
    { kind: 'text', text: 'NOVA_E2E_PARENT_DONE' }
  )

  await nova.sendPrompt('派一个子代理执行子任务')
  await nova.provider.waitForRequestCount(2)

  // 子代理活动行出现，权限条锚定在行内（带「子代理请求权限」标识）
  const activityRow = nova.page.locator('.subagent-activity-row')
  await expect(activityRow).toBeVisible()
  const anchoredBar = activityRow.locator('.inline-perm')
  await expect(activityRow.getByText('子代理请求权限', { exact: false })).toBeVisible()
  await expect(anchoredBar.getByRole('button', { name: '允许', exact: true })).toBeVisible()

  // 在父会话视图中允许后，子代理继续执行并完成；活动行随等待态一起收起，
  // 父轮次收到子代理结果后正常结束（子代理自身回复渲染在其子会话，父视图以父回复为准）
  await anchoredBar.getByRole('button', { name: '允许', exact: true }).click()
  await nova.provider.waitForRequestCount(4)
  await expect(activityRow).toHaveCount(0)
  await expect(nova.page.getByText('NOVA_E2E_PARENT_DONE', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()
  expect((await nova.getRunSnapshot(sessionId))?.status).toBe('completed')

  expect(nova.pageErrors).toEqual([])
})
