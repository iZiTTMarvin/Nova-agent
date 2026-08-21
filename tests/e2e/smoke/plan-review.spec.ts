/**
 * 计划审阅流关键路径 E2E
 *
 * 覆盖的回归：
 * - save_plan 后审阅卡出现在消息流中；模型保存计划后不得自行切换模式或改用提问面板审批
 * -「执行」切回默认模式并以新消息续跑实施，「需要更正」停留在计划模式
 * - 同一会话出现更新计划后，旧计划卡降级只读
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '../fixtures/nova'

const IMPLEMENT_PROMPT = '请读取当前 active plan，结合最新仓库状态开始实施，并在完成后运行相关验证。'
const CORRECTION_PROMPT = '这份计划需要更正，暂不执行。请询问我希望调整哪些部分，然后等待我的回复。'

async function readPlanMarkdown(workspacePath: string): Promise<string> {
  const planDir = path.join(workspacePath, '.nova', 'plans')
  const names = await readdir(planDir)
  const planNames = names.filter(name => name.endsWith('.md'))
  expect(planNames).toHaveLength(1)
  return readFile(path.join(planDir, planNames[0]), 'utf8')
}

test('save_plan 后审阅卡原位出现且不自切模式，「执行」切回默认模式并开新实施轮次', async ({ nova }) => {
  const state = await nova.createSession('plan')
  const sessionId = state.currentSessionId
  if (!sessionId) throw new Error('plan session id missing')

  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'save_plan',
      arguments: {
        title: '番茄钟计划甲',
        content: '# 番茄钟计划甲\n\n- 目标：做一个 25 分钟番茄钟\n- 验证：打开页面能看到计时器'
      },
      callId: 'call_save_plan'
    },
    { kind: 'text', text: 'NOVA_E2E_PLAN_READY' }
  )

  await nova.sendPrompt('先帮我制定一个计划')
  await nova.provider.waitForRequestCount(2)
  await expect(nova.page.getByText('NOVA_E2E_PLAN_READY', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()

  // 审阅卡出现在消息流中且整段计划可读
  const reviewCard = nova.page.getByLabel('计划审阅')
  await expect(reviewCard).toBeVisible()
  await expect(reviewCard).toContainText('番茄钟计划甲')
  expect(await readPlanMarkdown(nova.workspacePath)).toContain('# 番茄钟计划甲')

  // 模型保存计划后不自行切换模式：仍处计划模式、卡保持可操作、无提问面板代答
  await expect(nova.page.getByTestId('active-mode-chip')).toContainText('Plan')
  await expect(nova.page.locator('.ask-question-dock')).toHaveCount(0)
  const execute = reviewCard.getByRole('button', { name: '执行', exact: true })
  await expect(execute).toBeEnabled()
  await expect(reviewCard.getByText('已进入默认模式', { exact: false })).toHaveCount(0)

  // 「执行」→ 切回默认模式 + 代发实施消息开新轮次
  nova.provider.enqueue({ kind: 'text', text: 'NOVA_E2E_IMPLEMENT_DONE' })
  await execute.click()

  await expect(nova.page.getByTestId('active-mode-chip')).toHaveCount(0)
  await expect(reviewCard.getByText('已进入默认模式', { exact: false })).toBeVisible()

  await nova.provider.waitForRequestCount(3)
  const implementationRequest = JSON.stringify(nova.provider.requests[2]?.body ?? {})
  expect(implementationRequest).toContain(IMPLEMENT_PROMPT.slice(0, 24))
  await expect(nova.page.getByText('NOVA_E2E_IMPLEMENT_DONE', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()
  expect((await nova.getRunSnapshot(sessionId))?.status).toBe('completed')

  expect(nova.pageErrors).toEqual([])
})

test('「需要更正」停留在计划模式，更正消息作为新轮次发出', async ({ nova }) => {
  const state = await nova.createSession('plan')
  const sessionId = state.currentSessionId
  if (!sessionId) throw new Error('plan session id missing')

  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'save_plan',
      arguments: { title: '改版计划', content: '# 改版计划\n\n- 目标：先讨论再实施' },
      callId: 'call_save_plan_rev'
    },
    { kind: 'text', text: 'NOVA_E2E_PLAN_A' }
  )

  await nova.sendPrompt('帮我规划迭代方案')
  await nova.provider.waitForRequestCount(2)
  await expect(nova.page.getByText('NOVA_E2E_PLAN_A', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()

  const reviewCard = nova.page.getByLabel('计划审阅')
  await expect(reviewCard.getByRole('button', { name: '执行', exact: true })).toBeEnabled()

  nova.provider.enqueue({ kind: 'text', text: 'NOVA_E2E_CORRECTION_REPLY' })
  await reviewCard.getByRole('button', { name: '更多计划决策' }).click()
  await nova.page.getByRole('menuitem', { name: '需要更正' }).click()

  // 更正消息以新轮次发出：请求数 +1，消息在流中可见
  await nova.provider.waitForRequestCount(3)
  await expect(nova.page.getByText(CORRECTION_PROMPT, { exact: false })).toBeVisible()
  await expect(nova.page.getByText('NOVA_E2E_CORRECTION_REPLY', { exact: false })).toBeVisible()

  // 仍停留在计划模式：模式芯片保留，卡仍可操作
  await expect(nova.page.getByTestId('active-mode-chip')).toContainText('Plan')
  await expect(reviewCard.getByRole('button', { name: '执行', exact: true })).toBeEnabled()
  await nova.waitUntilIdle()

  const snapshot = await nova.getRunSnapshot(sessionId)
  expect(snapshot?.status).toBe('completed')
  expect(nova.pageErrors).toEqual([])
})

test('同一会话出现更新计划后，旧计划卡降级只读', async ({ nova }) => {
  const state = await nova.createSession('plan')
  const sessionId = state.currentSessionId
  if (!sessionId) throw new Error('plan session id missing')

  // 第一轮：保存计划 v1
  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'save_plan',
      arguments: { title: '旧版计划', content: '# 旧版计划\n\n- 内容一' },
      callId: 'call_save_plan_v1'
    },
    { kind: 'text', text: 'NOVA_E2E_PLAN_A' }
  )
  await nova.sendPrompt('请先生成第一版计划')
  await nova.provider.waitForRequestCount(2)
  await expect(nova.page.getByText('NOVA_E2E_PLAN_A', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()

  // 第二轮：同一会话内更新计划，旧卡片应降级只读
  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'save_plan',
      arguments: { title: '新版计划', content: '# 新版计划\n\n- 内容二' },
      callId: 'call_save_plan_v2'
    },
    { kind: 'text', text: 'NOVA_E2E_PLAN_B' }
  )
  await nova.sendPrompt('计划需要调整，请生成最新计划')
  await nova.provider.waitForRequestCount(4)
  await expect(nova.page.getByText('NOVA_E2E_PLAN_B', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()

  const cards = nova.page.getByLabel('计划审阅')
  await expect(cards).toHaveCount(2)
  await expect(nova.page.getByText('已有更新的计划版本，请以最新的计划卡片为准')).toBeVisible()
  await expect(cards.first().getByRole('button', { name: '执行', exact: true })).toHaveCount(0)
  await expect(cards.last().getByRole('button', { name: '执行', exact: true })).toBeEnabled()

  expect((await nova.getRunSnapshot(sessionId))?.status).toBe('completed')
  expect(nova.pageErrors).toEqual([])
})
