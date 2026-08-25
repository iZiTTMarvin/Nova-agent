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
    { kind: 'tool', name: 'stage_transition', arguments: { action: 'complete' }, callId: 'call_plan_review' }
  )

  await nova.sendPrompt('帮我做一个番茄钟 app')
  await nova.provider.waitForRequestCount(3)

  const waiting = await nova.getRunSnapshot(sessionId)
  expect(waiting?.status).toBe('waiting_user')
  await expectCurrentStage(nova.page, '计划')
  await expectCompletedCount(nova.page, 1)
  expect(await readPlanMarkdown(nova.workspacePath)).toContain('# 番茄钟 E2E 计划')

  const reviewCard = nova.page.locator('section.plan-review-card')
  await expect(reviewCard).toBeVisible()
  await expect(reviewCard).toContainText('番茄钟计划')
  const approve = nova.page.getByLabel('实施计划审批').getByRole('button', { name: '批准', exact: true })
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
  await nova.provider.waitForRequestCount(10)
  await expectCurrentStage(nova.page, '收尾')
  await expect(nova.page.getByText('NOVA_E2E_XFORGE_REPORT', { exact: false })).toBeVisible()
  await expect(nova.page.getByLabel('实施计划审批')).toHaveCount(0)
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
