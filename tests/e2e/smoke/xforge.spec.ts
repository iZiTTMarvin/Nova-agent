import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/nova'

const STAGE_BAR = '.compose-stage-bar'
const CURRENT_STAGE = `${STAGE_BAR}__node[aria-current="step"]`
const COMPLETED_STAGE = `${STAGE_BAR}__node--completed`

async function readPlanMarkdown(workspacePath: string): Promise<string> {
  const planDir = path.join(workspacePath, '.nova', 'plans')
  const names = await readdir(planDir)
  const planNames = names.filter(name => name.endsWith('.md'))
  expect(planNames).toHaveLength(1)
  return readFile(path.join(planDir, planNames[0]), 'utf8')
}

async function expectCurrentStage(page: Page, label: string): Promise<void> {
  await expect(page.locator(CURRENT_STAGE)).toContainText(label)
}

async function expectCompletedCount(page: Page, count: number): Promise<void> {
  await expect(page.locator(COMPLETED_STAGE)).toHaveCount(count)
}

test('XForge 手动批准：计划硬门拦住开发，批准后走完六阶段', async ({ nova }) => {
  const state = await nova.createSession('compose')
  const sessionId = state.currentSessionId
  expect(sessionId).not.toBeNull()
  if (!sessionId) throw new Error('compose session id missing')

  await expect(nova.page.getByLabel('生命周期阶段')).toBeVisible()
  await expect(nova.page.locator(`${STAGE_BAR}__node`)).toHaveCount(6)
  await expectCurrentStage(nova.page, '构思')

  nova.provider.enqueue(
    { kind: 'tool', name: 'stage_transition', arguments: { action: 'complete' }, callId: 'call_brainstorm_done' },
    {
      kind: 'tool',
      name: 'save_plan',
      arguments: {
        title: '番茄钟计划',
        content: '# 番茄钟 E2E 计划\n\n- 目标：做一个 25 分钟番茄钟\n- 验证：打开页面能看到计时器'
      },
      callId: 'call_save_plan'
    },
    { kind: 'tool', name: 'stage_transition', arguments: { action: 'complete' }, callId: 'call_plan_gate_locked' },
    { kind: 'text', text: 'NOVA_E2E_PLAN_READY' }
  )

  await nova.sendPrompt('帮我做一个番茄钟 app')
  await nova.provider.waitForRequestCount(4)
  await expect(nova.page.getByText('NOVA_E2E_PLAN_READY', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()

  // 计划硬门：未经批准时 stage_transition(complete) 必须被拒绝并回灌给模型
  const gateRequest = JSON.stringify(nova.provider.requests[3]?.body ?? {})
  expect(gateRequest).toContain('计划尚未获得用户批准')

  await expectCurrentStage(nova.page, '计划')
  await expectCompletedCount(nova.page, 1)
  expect(await readPlanMarkdown(nova.workspacePath)).toContain('# 番茄钟 E2E 计划')

  const reviewCard = nova.page.getByLabel('计划审阅')
  await expect(reviewCard).toBeVisible()
  await expect(reviewCard).toContainText('番茄钟计划')
  const approve = nova.page.getByRole('button', { name: /批准并开始开发/ })
  await expect(approve).toBeEnabled()

  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'todo_write',
      arguments: {
        todos: [{ content: '创建番茄钟页面', status: 'in_progress', priority: 'high' }]
      },
      callId: 'call_todo_import'
    },
    { kind: 'tool', name: 'stage_transition', arguments: { action: 'complete' }, callId: 'call_plan_done' },
    {
      kind: 'tool',
      name: 'write',
      arguments: {
        path: 'tomato-timer.html',
        content: '<!doctype html><title>Nova E2E Tomato Timer</title><h1>25:00</h1>'
      },
      callId: 'call_write_implement'
    },
    {
      kind: 'tool',
      name: 'todo_write',
      arguments: {
        todos: [{ content: '创建番茄钟页面', status: 'completed', priority: 'high' }]
      },
      callId: 'call_todo_complete'
    },
    { kind: 'tool', name: 'stage_transition', arguments: { action: 'complete' }, callId: 'call_implement_done' },
    { kind: 'tool', name: 'stage_transition', arguments: { action: 'complete' }, callId: 'call_verify_done' },
    { kind: 'tool', name: 'stage_transition', arguments: { action: 'complete' }, callId: 'call_review_done' },
    { kind: 'text', text: 'NOVA_E2E_XFORGE_REPORT' }
  )

  await approve.click()
  await nova.provider.waitForRequestCount(12)
  await expectCurrentStage(nova.page, '收尾')
  await expect(nova.page.getByText('NOVA_E2E_XFORGE_REPORT', { exact: false })).toBeVisible()
  await expect(reviewCard).toContainText('已批准，进入「开发」阶段')
  await nova.waitUntilIdle()

  expect(await readFile(path.join(nova.workspacePath, 'tomato-timer.html'), 'utf8'))
    .toContain('Nova E2E Tomato Timer')

  // 收尾阶段手动完成，真实走阶段条菜单的兜底入口
  await nova.page.getByLabel('阶段操作').click()
  await nova.page.getByRole('menuitem', { name: '完成当前阶段' }).click()
  await expectCompletedCount(nova.page, 6)
  await expect(nova.page.locator(CURRENT_STAGE)).toHaveCount(0)

  expect(nova.pageErrors).toEqual([])
})

test('XForge 全自动：计划门自动放行并闭环走完六阶段', async ({ nova }) => {
  const state = await nova.createSession('compose')
  const sessionId = state.currentSessionId
  expect(sessionId).not.toBeNull()
  if (!sessionId) throw new Error('compose session id missing')

  await expect(nova.page.getByLabel('生命周期阶段')).toBeVisible()
  const autoToggle = nova.page.getByRole('button', { name: '全自动完成' })
  await expect(autoToggle).toBeVisible()
  await expect(autoToggle).toHaveAttribute('aria-pressed', 'false')
  await autoToggle.click()
  await expect(autoToggle).toHaveAttribute('aria-pressed', 'true')

  nova.provider.enqueue(
    { kind: 'tool', name: 'stage_transition', arguments: { action: 'complete' }, callId: 'auto_brainstorm_done' },
    {
      kind: 'tool',
      name: 'save_plan',
      arguments: {
        title: '自动番茄钟计划',
        content: '# 自动番茄钟计划\n\n- 目标：验证全自动模式\n- 验证：文件落盘'
      },
      callId: 'auto_save_plan'
    },
    { kind: 'tool', name: 'stage_transition', arguments: { action: 'complete' }, callId: 'auto_plan_done' },
    {
      kind: 'tool',
      name: 'write',
      arguments: {
        path: 'auto-timer.html',
        content: '<!doctype html><title>Nova E2E Auto Timer</title>'
      },
      callId: 'auto_write'
    },
    { kind: 'tool', name: 'stage_transition', arguments: { action: 'complete' }, callId: 'auto_implement_done' },
    { kind: 'tool', name: 'stage_transition', arguments: { action: 'complete' }, callId: 'auto_verify_done' },
    { kind: 'tool', name: 'stage_transition', arguments: { action: 'complete' }, callId: 'auto_review_done' },
    { kind: 'tool', name: 'stage_transition', arguments: { action: 'complete' }, callId: 'auto_report_done' },
    { kind: 'text', text: 'NOVA_E2E_AUTO_XFORGE_DONE' }
  )

  await nova.sendPrompt('全自动帮我做一个番茄钟 app')
  await nova.provider.waitForRequestCount(9)
  await expect(nova.page.getByText('NOVA_E2E_AUTO_XFORGE_DONE', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()

  // auto 提示必须真实进入该轮 prompt，而不是只在 UI 上把开关点亮
  const planApprovalRequest = JSON.stringify(nova.provider.requests[2]?.body ?? {})
  expect(planApprovalRequest).toContain('[自动推进已开启]')

  await expect(nova.page.getByText('已自动批准（auto 模式）', { exact: false })).toBeVisible()
  await expect(nova.page.getByRole('button', { name: /批准并开始开发/ })).toHaveCount(0)
  await expectCompletedCount(nova.page, 6)
  await expect(nova.page.locator(CURRENT_STAGE)).toHaveCount(0)

  const planContent = await readPlanMarkdown(nova.workspacePath)
  expect(planContent).toContain('# 自动番茄钟计划')
  expect(await readFile(path.join(nova.workspacePath, 'auto-timer.html'), 'utf8'))
    .toContain('Nova E2E Auto Timer')

  expect((await nova.getRunSnapshot(sessionId))?.status).toBe('completed')
  expect(nova.pageErrors).toEqual([])
})
