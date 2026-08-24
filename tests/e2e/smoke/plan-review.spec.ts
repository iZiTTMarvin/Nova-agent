import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '../fixtures/nova'

async function readPlanMarkdown(workspacePath: string): Promise<string> {
  const planDir = path.join(workspacePath, '.nova', 'plans')
  const names = (await readdir(planDir)).filter(name => name.endsWith('.md'))
  expect(names).toHaveLength(1)
  return readFile(path.join(planDir, names[0]), 'utf8')
}

function savePlan(callId: string, content: string) {
  return {
    kind: 'tool' as const,
    name: 'save_plan',
    arguments: { title: '番茄钟实施计划', content },
    callId
  }
}

function requestDefaultMode(callId: string) {
  return {
    kind: 'tool' as const,
    name: 'switch_mode',
    arguments: { mode: 'default', reason: '计划已保存，等待批准后开始实施' },
    callId
  }
}

test('批准计划后在同一 run 继续实施，计划与审批按源顺序显示', async ({ nova }) => {
  const state = await nova.createSession('plan')
  const sessionId = state.currentSessionId
  if (!sessionId) throw new Error('plan session id missing')

  nova.provider.enqueue(
    savePlan('call-save-plan', '# 番茄钟实施计划\n\n- 实现 25 分钟计时\n- 验证倒计时'),
    requestDefaultMode('call-switch-mode'),
    { kind: 'text', text: 'NOVA_E2E_IMPLEMENT_DONE' }
  )

  await nova.sendPrompt('先制定计划，批准后继续实施')
  await nova.provider.waitForRequestCount(2)

  const waiting = await nova.getRunSnapshot(sessionId)
  expect(waiting?.status).toBe('waiting_user')
  const runId = waiting?.runId
  const planCard = nova.page.locator('section.plan-review-card')
  const approvalCard = nova.page.getByLabel('实施计划审批')
  await expect(planCard).toHaveCount(1)
  await expect(planCard).toContainText('番茄钟实施计划')
  await expect(approvalCard).toBeVisible()
  await expect(nova.page.getByTestId('turn-process-header')).toContainText('工作中')
  await expect(nova.page.locator('.turn-process-tree__chevron')).toHaveCount(0)
  expect(await readPlanMarkdown(nova.workspacePath)).toContain('实现 25 分钟计时')

  await planCard.getByRole('button', { name: '查看完整计划 →' }).click()
  await expect(nova.page.locator('.inspector-plan')).toBeVisible()
  await expect(nova.page.locator('.inspector-plan__document')).toContainText('验证倒计时')
  await nova.page.getByRole('button', { name: '关闭计划' }).click()
  await expect(nova.page.locator('.inspector-panel')).toHaveAttribute('aria-hidden', 'true')

  await approvalCard.getByRole('button', { name: '批准', exact: true }).click()
  await nova.provider.waitForRequestCount(3)
  await expect(nova.page.getByText('NOVA_E2E_IMPLEMENT_DONE', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()

  const completed = await nova.getRunSnapshot(sessionId)
  expect(completed?.runId).toBe(runId)
  expect(completed?.status).toBe('completed')
  await expect(nova.page.getByTestId('active-mode-chip')).toHaveCount(0)
  // 完成后整个工作过程（含计划卡）折叠，只留最终答复；展开可回看
  await expect(planCard).toHaveCount(0)
  await nova.page.getByTestId('turn-process-header').click()
  await expect(planCard).toHaveCount(1)
  await expect(approvalCard).toHaveCount(0)
  expect(JSON.stringify(nova.provider.requests[2]?.body ?? {})).not.toContain('请读取当前 active plan')
  expect(nova.pageErrors).toEqual([])
})

test('修改意见回灌同一 run，再次保存时原位更新唯一计划卡', async ({ nova }) => {
  const state = await nova.createSession('plan')
  const sessionId = state.currentSessionId
  if (!sessionId) throw new Error('plan session id missing')

  nova.provider.enqueue(
    savePlan('call-save-v1', '# 番茄钟实施计划\n\n- 第一版'),
    requestDefaultMode('call-switch-v1'),
    savePlan('call-save-v2', '# 番茄钟实施计划\n\n- 第二版\n- 增加暂停与继续'),
    requestDefaultMode('call-switch-v2')
  )

  await nova.sendPrompt('生成可审阅计划')
  await nova.provider.waitForRequestCount(2)
  const firstRun = await nova.getRunSnapshot(sessionId)
  const approvalCard = nova.page.getByLabel('实施计划审批')
  await expect(approvalCard).toBeVisible()

  const feedback = approvalCard.locator('textarea')
  await feedback.fill('增加暂停与继续，并补充验证')
  await approvalCard.getByRole('button', { name: '提交修改' }).click()
  await nova.provider.waitForRequestCount(4)

  const secondWaiting = await nova.getRunSnapshot(sessionId)
  expect(secondWaiting?.runId).toBe(firstRun?.runId)
  expect(secondWaiting?.status).toBe('waiting_user')
  await expect(nova.page.locator('section.plan-review-card')).toHaveCount(1)
  await expect(nova.page.locator('section.plan-review-card')).toContainText('增加暂停与继续')
  expect(await readPlanMarkdown(nova.workspacePath)).toContain('第二版')
  expect(JSON.stringify(nova.provider.requests[2]?.body ?? {})).toContain('增加暂停与继续，并补充验证')

  await nova.page.getByLabel('实施计划审批').getByRole('button', { name: '忽略' }).click()
  await nova.waitUntilIdle()
  expect((await nova.getRunSnapshot(sessionId))?.status).toBe('completed')
  await expect(nova.page.getByTestId('active-mode-chip')).toContainText('Plan')
  expect(nova.pageErrors).toEqual([])
})

test('忽略计划正常完成当前 run，并保留 Plan 模式和 active plan', async ({ nova }) => {
  const state = await nova.createSession('plan')
  const sessionId = state.currentSessionId
  if (!sessionId) throw new Error('plan session id missing')

  nova.provider.enqueue(
    savePlan('call-save-ignore', '# 番茄钟实施计划\n\n- 暂不实施'),
    requestDefaultMode('call-switch-ignore')
  )

  await nova.sendPrompt('生成计划但先不实施')
  await nova.provider.waitForRequestCount(2)
  const waiting = await nova.getRunSnapshot(sessionId)
  expect(waiting?.status).toBe('waiting_user')

  await nova.page.getByLabel('实施计划审批').getByRole('button', { name: '忽略' }).click()
  await nova.waitUntilIdle()

  const completed = await nova.getRunSnapshot(sessionId)
  expect(completed?.runId).toBe(waiting?.runId)
  expect(completed?.status).toBe('completed')
  expect(completed?.terminalReason).toBeUndefined()
  await expect(nova.page.getByTestId('active-mode-chip')).toContainText('Plan')
  // 忽略决定持久记录在审批卡上：完成后随工作过程折叠，展开可见灰态「已忽略」
  await nova.page.getByTestId('turn-process-header').click()
  await expect(nova.page.getByLabel('实施计划审批')).toContainText('已忽略')
  await expect(nova.page.locator('section.plan-review-card')).toHaveCount(1)
  expect(await readPlanMarkdown(nova.workspacePath)).toContain('暂不实施')
  expect(nova.pageErrors).toEqual([])
})
