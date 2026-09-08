import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { LOAD_SESSION_MESSAGES } from '../../../src/shared/ipc/channels'
import type { Message, MessageBlock } from '../../../src/shared/session/types'
import { expect, test, type NovaHarness } from '../fixtures/nova'

const CAPSULE = '.xforge-capsule'
const CAPSULE_CHIP = `${CAPSULE}__chip`
const CRITIC_DENIAL = '一页纸还没有经过批评者挑刺'
const PLAN_CONTENT = [
  '# 番茄钟一页纸',
  '',
  '## 你要的东西',
  '一个 25 分钟番茄钟',
  '',
  '## 做完你能做什么',
  '1. 打开页面能看到计时器',
  '',
  '## 我决定不做的',
  '不做账号',
  '',
  '## 技术选择',
  '单文件 HTML，理由是足够小'
].join('\n')

async function readPlanMarkdown(workspacePath: string): Promise<string> {
  const planDir = path.join(workspacePath, '.nova', 'plans')
  const names = await readdir(planDir)
  const planNames = names.filter(name => name.endsWith('.md'))
  expect(planNames).toHaveLength(1)
  return readFile(path.join(planDir, planNames[0]), 'utf8')
}

async function expectCapsuleStage(page: Page, label: string): Promise<void> {
  await expect(page.locator(CAPSULE)).toBeVisible()
  await expect(page.locator(CAPSULE_CHIP)).toContainText(label)
}

async function loadMessages(nova: NovaHarness, sessionId: string): Promise<Message[]> {
  const result = await nova.invoke(LOAD_SESSION_MESSAGES, { sessionId, limit: 200 })
  return result.messages
}

function toolResults(messages: readonly Message[], toolName: string): string[] {
  return messages.flatMap(message =>
    (message.blocks ?? []).filter(
      (block): block is Extract<MessageBlock, { type: 'tool' }> =>
        block.type === 'tool' && block.toolName === toolName
    ).map(block => block.result ?? '')
  )
}

test('XForge 手动批准：批评者与核验者跑完后走完五步', async ({ nova }) => {
  test.setTimeout(90_000)
  const state = await nova.createSession('compose')
  const sessionId = state.currentSessionId
  expect(sessionId).not.toBeNull()
  if (!sessionId) throw new Error('compose session id missing')

  await expect(nova.page.locator(CAPSULE)).toBeVisible()
  await expect(nova.page.locator('.compose-stage-bar')).toHaveCount(0)
  await expectCapsuleStage(nova.page, '问')

  await nova.page.locator(CAPSULE_CHIP).click()
  await expect(nova.page.locator(CAPSULE)).toContainText('暂无一页纸')

  nova.provider.enqueue(
    { kind: 'tool', name: 'stage_transition', arguments: { action: 'complete' }, callId: 'call_interview_done' },
    {
      kind: 'tool',
      name: 'save_plan',
      arguments: {
        title: '番茄钟计划',
        content: PLAN_CONTENT
      },
      callId: 'call_save_plan'
    },
    {
      kind: 'tool',
      name: 'task',
      arguments: { subagent_type: 'critic', task: '挑刺这份一页纸' },
      callId: 'call_critic'
    },
    { kind: 'text', text: '建议砍掉：账号系统。必须补上：无。会坏的地方：刷新会丢。技术选择意见：单文件即可。' },
    { kind: 'tool', name: 'stage_transition', arguments: { action: 'complete' }, callId: 'call_blueprint_review' }
  )

  await nova.sendPrompt('帮我做一个番茄钟 app')
  const approval = nova.page.getByLabel('实施计划审批')
  await expect(approval).toBeVisible()
  await expect(approval.getByRole('heading', { name: '确认一页纸' })).toBeVisible()
  await expectCapsuleStage(nova.page, '图')
  await expect(nova.page.locator(`${CAPSULE}__checklist`)).toContainText('打开页面能看到计时器')
  const waiting = await nova.getRunSnapshot(sessionId)
  expect(waiting?.status).toBe('waiting_user')
  await expect(nova.page.locator('.xforge-capsule__glyph')).toHaveCSS('animation-name', 'none')
  expect(await readPlanMarkdown(nova.workspacePath)).toContain('做完你能做什么')

  const approve = approval.getByRole('button', { name: '批准', exact: true })
  await expect(approve).toBeEnabled()

  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'todo_write',
      arguments: {
        todos: [{ content: '打开页面能看到计时器', status: 'in_progress', priority: 'high' }]
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
        todos: [{ content: '打开页面能看到计时器', status: 'completed', priority: 'high' }]
      },
      callId: 'call_todo_complete'
    },
    { kind: 'tool', name: 'stage_transition', arguments: { action: 'complete' }, callId: 'call_build_done' },
    { kind: 'tool', name: 'stage_transition', arguments: { action: 'skip', reason: '未运行核验' }, callId: 'call_inspect_skip' },
    {
      kind: 'tool',
      name: 'task',
      arguments: { subagent_type: 'inspector', task: '按一页纸逐条操作核验' },
      callId: 'call_inspector'
    },
    { kind: 'tool', name: 'bash', arguments: { command: 'echo ok' }, callId: 'call_inspector_bash' },
    { kind: 'text', text: '打开页面能看到计时器 ✓ 标题可见。\n结论：通过' },
    { kind: 'tool', name: 'stage_transition', arguments: { action: 'complete' }, callId: 'call_inspect_done' },
    { kind: 'text', text: 'NOVA_E2E_XFORGE_REPORT' }
  )

  await approve.click()
  await expect(nova.page.getByText('NOVA_E2E_XFORGE_REPORT', { exact: false })).toBeVisible()
  await expectCapsuleStage(nova.page, '交')
  await expect(nova.page.getByLabel('实施计划审批')).toHaveCount(0)
  await nova.waitUntilIdle()

  expect(toolResults(await loadMessages(nova, sessionId), 'stage_transition').some(result => result.includes('不能跳过'))).toBe(true)

  expect(await readFile(path.join(nova.workspacePath, 'tomato-timer.html'), 'utf8'))
    .toContain('Nova E2E Tomato Timer')
  expect(nova.pageErrors).toEqual([])
})

test('无 critic 时无法完成图阶段', async ({ nova }) => {
  const state = await nova.createSession('compose')
  const sessionId = state.currentSessionId
  expect(sessionId).not.toBeNull()
  if (!sessionId) throw new Error('compose session id missing')

  await expectCapsuleStage(nova.page, '问')

  nova.provider.enqueue(
    { kind: 'tool', name: 'stage_transition', arguments: { action: 'complete' }, callId: 'call_interview_done' },
    {
      kind: 'tool',
      name: 'save_plan',
      arguments: {
        title: '番茄钟计划',
        content: PLAN_CONTENT
      },
      callId: 'call_save_plan'
    },
    { kind: 'tool', name: 'stage_transition', arguments: { action: 'complete' }, callId: 'call_blueprint_without_critic' },
    { kind: 'tool', name: 'stage_transition', arguments: { action: 'skip', reason: '没有批评者' }, callId: 'call_blueprint_skip' },
    { kind: 'text', text: 'NOVA_E2E_XFORGE_NO_CRITIC' }
  )

  await nova.sendPrompt('帮我做一个番茄钟 app')
  await expect(nova.page.getByText('NOVA_E2E_XFORGE_NO_CRITIC', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()
  await expectCapsuleStage(nova.page, '图')

  const results = toolResults(await loadMessages(nova, sessionId), 'stage_transition')
  expect(results.some(result => result.includes(CRITIC_DENIAL))).toBe(true)
  expect(results.some(result => result.includes('不能跳过'))).toBe(true)
  expect(nova.pageErrors).toEqual([])
})

test('运行中补充可排队，暂停保留草稿与队列，显式继续后只发送一次', async ({ nova }) => {
  await nova.createSession('compose')
  const glyph = nova.page.locator('.xforge-capsule__glyph')
  await expect(glyph).toHaveCSS('animation-name', 'none')
  nova.provider.enqueue({ kind: 'hold', id: 'supplement-hold', text: 'SHOULD_NOT_FINISH' })
  await nova.sendPrompt('保持运行以验证补充')
  await nova.provider.waitForRequestCount(1)
  await expect(glyph).toHaveCSS('animation-name', 'xforge-consider')
  await nova.page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(glyph).toHaveCSS('animation-name', 'none')
  await nova.page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(glyph).toHaveCSS('animation-name', 'xforge-consider')
  const editor = nova.page.getByLabel('消息输入')
  await expect(editor).toBeEmpty()
  await editor.fill('排队补充：标题小账本')
  await editor.press('Enter')
  await expect(nova.page.locator('.steering-queue')).toContainText('排队补充：标题小账本')
  await expect(editor).toBeEmpty()
  await editor.fill('尚未发送的下一条草稿')
  await nova.page.getByRole('button', { name: '中断生成' }).click()
  await nova.waitUntilIdle()
  await expect(glyph).toHaveCSS('animation-name', 'none')
  await expect(editor).toContainText('尚未发送的下一条草稿')
  await expect(nova.page.locator('.steering-queue')).toContainText('排队补充：标题小账本')
  expect(nova.provider.requests).toHaveLength(1)
  nova.provider.enqueue({ kind: 'text', text: 'SUPPLEMENT_PROCESSED' })
  await nova.page.getByRole('button', { name: '发送排队消息' }).click()
  await expect(nova.page.getByText('SUPPLEMENT_PROCESSED', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()
  expect(nova.provider.requests).toHaveLength(2)
  await expect(nova.page.locator('.steering-queue')).toHaveCount(0)
  await expect(editor).toContainText('尚未发送的下一条草稿')
  expect(nova.pageErrors).toEqual([])
})

test('reload 后胶囊仍显示同一阶段字', async ({ nova }) => {
  const state = await nova.createSession('compose')
  expect(state.currentSessionId).not.toBeNull()

  await expectCapsuleStage(nova.page, '问')

  nova.provider.enqueue(
    { kind: 'tool', name: 'stage_transition', arguments: { action: 'complete' }, callId: 'call_interview_done' }
  )

  await nova.sendPrompt('开始访谈后进入图')
  await expectCapsuleStage(nova.page, '图')
  await nova.waitUntilIdle()
  await expectCapsuleStage(nova.page, '图')

  await nova.page.reload()
  await nova.page.waitForFunction(() => Boolean((window as typeof window & { api?: unknown }).api))
  await expect(nova.page.getByLabel('消息输入')).toBeVisible()
  await expectCapsuleStage(nova.page, '图')
  expect(nova.pageErrors).toEqual([])
})
