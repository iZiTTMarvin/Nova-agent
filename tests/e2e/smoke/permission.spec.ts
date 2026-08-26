/**
 * 权限模式闭环 E2E
 *
 * 覆盖的回归：
 * - 新会话默认「自动」；高风险命令升级为内联权限条，允许一次后真实执行
 * - 切换「完全访问」必须二次确认，取消不改状态；完全访问下同一命令不再请求
 * - 切回「自动」后同一命令再次请求；拒绝不阻断整轮
 * - Plan 模式下 write / bash 不可执行（不受权限模式放宽），且无权限条
 * - reload 后会话权限模式恢复为「自动」（持久化与 listener 重绑定）
 * - 子代理权限请求锚定父会话活动行（子代理继承父会话权限模式）
 */
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '../fixtures/nova'

const HIGH_RISK_COMMAND = 'Remove-Item -Recurse -Force perm-e2e-target'

test('权限模式闭环：自动询问 → 完全访问放行 → 回自动再询问 → Plan 收窄 → reload 恢复', async ({ nova }) => {
  const state = await nova.createSession('default')
  const sessionId = state.currentSessionId
  if (!sessionId) throw new Error('session id missing')
  const targetDir = path.join(nova.workspacePath, 'perm-e2e-target')
  const shield = nova.page.locator('.permission-mode__trigger')

  // 新会话默认「自动」
  await expect(shield).toBeVisible()
  await expect(shield).toContainText('自动')

  // 高风险命令在自动档升级为内联权限条
  await mkdir(targetDir, { recursive: true })
  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'bash',
      arguments: { command: HIGH_RISK_COMMAND },
      callId: 'call_risk_ask'
    },
    { kind: 'text', text: 'NOVA_E2E_ALLOWED_ONCE' }
  )
  await nova.sendPrompt('执行需要授权的删除命令')
  await expect.poll(async () => (await nova.getRunSnapshot(sessionId))?.status)
    .toBe('waiting_user')
  const permissionBar = nova.page.locator('.inline-perm')
  await expect(permissionBar.getByRole('button', { name: '允许一次', exact: true })).toBeVisible()
  await expect(permissionBar.getByRole('button', { name: '拒绝', exact: true })).toBeVisible()

  // 允许一次：命令真实执行（目标目录被删除），整轮完成
  await permissionBar.getByRole('button', { name: '允许一次', exact: true }).click()
  await nova.provider.waitForRequestCount(2)
  await expect(nova.page.getByText('NOVA_E2E_ALLOWED_ONCE', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()
  await expect.poll(() => !existsSync(targetDir)).toBe(true)

  // 切换完全访问必须二次确认；取消不改状态
  await shield.click()
  await nova.page.getByRole('menuitem', { name: '完全访问' }).click()
  const dialog = nova.page.locator('.full-access-confirm')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(shield).toContainText('自动')

  await shield.click()
  await nova.page.getByRole('menuitem', { name: '完全访问' }).click()
  await nova.page
    .locator('.full-access-confirm')
    .getByRole('button', { name: '启用完全访问' })
    .click()
  await expect(shield).toContainText('完全访问')

  // 完全访问下同一高风险命令不再请求
  await mkdir(targetDir, { recursive: true })
  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'bash',
      arguments: { command: HIGH_RISK_COMMAND },
      callId: 'call_risk_full'
    },
    { kind: 'text', text: 'NOVA_E2E_FULL_ACCESS_DONE' }
  )
  await nova.sendPrompt('再执行一次同样的命令')
  await expect(nova.page.getByText('NOVA_E2E_FULL_ACCESS_DONE', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()
  await expect(nova.page.locator('.inline-perm')).toHaveCount(0)
  await expect.poll(() => !existsSync(targetDir)).toBe(true)

  // 切回自动：同一命令再次请求；拒绝不阻断整轮
  await shield.click()
  await nova.page.getByRole('menuitem', { name: '自动' }).click()
  await expect(shield).toContainText('自动')
  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'bash',
      arguments: { command: HIGH_RISK_COMMAND },
      callId: 'call_risk_back'
    },
    { kind: 'text', text: 'NOVA_E2E_DENIED_THEN_DONE' }
  )
  await nova.sendPrompt('第三次执行同样的命令')
  await expect.poll(async () => (await nova.getRunSnapshot(sessionId))?.status)
    .toBe('waiting_user')
  await nova.page
    .locator('.inline-perm')
    .getByRole('button', { name: '拒绝', exact: true })
    .click()
  await expect(nova.page.getByText('NOVA_E2E_DENIED_THEN_DONE', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()

  // Plan 模式收窄：write 与 bash 均不可执行（文件不落盘），且不产生权限条
  await nova.page.getByRole('button', { name: '添加工作流、上下文与工具' }).click()
  await nova.page.getByRole('menuitem', { name: '计划模式' }).click()
  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'write',
      arguments: { path: 'plan-guard.txt', content: 'should not exist' },
      callId: 'call_plan_write'
    },
    {
      kind: 'tool',
      name: 'bash',
      arguments: { command: 'echo plan-guard > bash-guard.txt' },
      callId: 'call_plan_bash'
    },
    { kind: 'text', text: 'NOVA_E2E_PLAN_GUARDED' }
  )
  await nova.sendPrompt('在计划模式尝试写文件和执行命令')
  await expect(nova.page.getByText('NOVA_E2E_PLAN_GUARDED', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()
  await expect(nova.page.locator('.inline-perm')).toHaveCount(0)
  expect(existsSync(path.join(nova.workspacePath, 'plan-guard.txt'))).toBe(false)
  expect(existsSync(path.join(nova.workspacePath, 'bash-guard.txt'))).toBe(false)

  // reload 后会话权限模式恢复为「自动」
  await nova.page.reload()
  await nova.page.waitForFunction(() =>
    Boolean((window as typeof window & { api?: unknown }).api)
  )
  await expect(nova.page.locator('.permission-mode__trigger')).toContainText('自动')
  expect(nova.pageErrors).toEqual([])
})

test('子代理继承父会话权限模式，权限请求锚定父会话活动行并可回应', async ({ nova }) => {
  const state = await nova.createSession('default')
  const sessionId = state.currentSessionId
  if (!sessionId) throw new Error('session id missing')
  const targetDir = path.join(nova.workspacePath, 'sub-perm-target')
  await mkdir(targetDir, { recursive: true })

  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'task',
      arguments: { subagent_type: 'code', task: '删除子任务目录并汇报' },
      callId: 'call_task_spawn'
    },
    // 子代理第一轮请求高风险 bash 权限（继承父会话「自动」→ 高风险询问）
    {
      kind: 'tool',
      name: 'bash',
      arguments: { command: 'Remove-Item -Recurse -Force sub-perm-target' },
      callId: 'call_sub_bash'
    },
    { kind: 'text', text: 'NOVA_E2E_SUBAGENT_DONE' },
    { kind: 'text', text: 'NOVA_E2E_PARENT_DONE' }
  )

  await nova.sendPrompt('派一个子代理执行子任务')
  await nova.provider.waitForRequestCount(2)

  const activityRow = nova.page.locator('.subagent-activity-row')
  await expect(activityRow).toBeVisible()
  const anchoredBar = activityRow.locator('.inline-perm')
  await expect(activityRow.getByText('子代理请求权限', { exact: false })).toBeVisible()
  await expect(anchoredBar.getByRole('button', { name: '允许一次', exact: true })).toBeVisible()

  // 在父会话视图中允许后，子代理命令真实执行并完成整轮
  await anchoredBar.getByRole('button', { name: '允许一次', exact: true }).click()
  await nova.provider.waitForRequestCount(4)
  await expect(activityRow).toHaveCount(0)
  await expect(nova.page.getByText('NOVA_E2E_PARENT_DONE', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()
  await expect.poll(() => !existsSync(targetDir)).toBe(true)
  expect((await nova.getRunSnapshot(sessionId))?.status).toBe('completed')

  expect(nova.pageErrors).toEqual([])
})
