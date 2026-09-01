/**
 * 子代理 followup 生命周期：撞轮数上限 → 续跑带历史 → 投影按 run 独立 →
 * 父取消级联 → renderer reload 重水合。
 *
 * 父子会话共用同一个 fake provider 队列（子会话 header 路由到同一 activeModel），
 * enqueue 按「父请求 → 子请求 → 父收尾」的确定性顺序编排，请求体按唯一标记断言。
 */
import { expect, test, type NovaHarness } from '../fixtures/nova'
import {
  LOAD_SESSION_MESSAGES,
  RUN_GET_SNAPSHOT,
  SUBAGENTS_CREATE,
  SUBAGENT_LIST_PROJECTIONS
} from '../../../src/shared/ipc/channels'
import type { Message, MessageBlock } from '../../../src/shared/session/types'
import type { SubAgentSpec } from '../../../src/shared/settings/types'
import type { SubagentActivityProjection } from '../../../src/shared/subagents'
import type { RunSnapshot } from '../../../src/shared/run/types'

const PRESET_ID = 'e2e-followup-probe'
const PRESET_NAME = 'E2E 轮数探针'
// 探针 system prompt 的唯一标记：用于把子代理请求与父会话请求区分开
const PROBE_PROMPT_MARKER = 'NOVA_E2E_PROBE_SYSTEM_PROMPT'
const INITIAL_TASK = 'NOVA_E2E_FOLLOWUP_INITIAL_TASK 检查工作区根目录'
const FOLLOWUP_TASK = 'NOVA_E2E_FOLLOWUP_INSTRUCTION 基于已有发现给出结论'
const CHILD_FINAL_REPORT = 'NOVA_E2E_CHILD_FINAL_REPORT'
const PARENT_TEXT_AFTER_LIMIT = 'NOVA_E2E_PARENT_AFTER_LIMIT'
const PARENT_TEXT_AFTER_FOLLOWUP = 'NOVA_E2E_PARENT_AFTER_FOLLOWUP'
const ROUND_LIMIT_NOTICE = '已达到最大工具调用轮数 1'
const ROUND_LIMIT_ERROR = '子代理未完成任务（已达工具轮数上限）'

type ToolBlockView = Extract<MessageBlock, { type: 'tool' }>

interface ProbeRun {
  readonly parentSessionId: string
  readonly childSessionId: string
  readonly birthRunId: string
}

function probePreset(): SubAgentSpec {
  return {
    id: PRESET_ID,
    name: PRESET_NAME,
    description: 'followup 生命周期验证用的低轮数探针',
    enabled: true,
    allowedTools: ['ls'],
    prompt: `${PROBE_PROMPT_MARKER} 用 ls 列目录并汇报。`,
    maxToolRounds: 1
  }
}

async function listProjections(
  nova: NovaHarness,
  parentSessionId: string
): Promise<SubagentActivityProjection[]> {
  return nova.invoke(SUBAGENT_LIST_PROJECTIONS, { parentSessionId })
}

async function loadMessages(nova: NovaHarness, sessionId: string): Promise<Message[]> {
  const result = await nova.invoke(LOAD_SESSION_MESSAGES, { sessionId, limit: 200 })
  return result.messages
}

function toolBlocks(messages: readonly Message[], toolName: string): ToolBlockView[] {
  return messages.flatMap(message =>
    (message.blocks ?? []).filter(
      (block): block is ToolBlockView => block.type === 'tool' && block.toolName === toolName
    )
  )
}

async function runSnapshot(
  nova: NovaHarness,
  sessionId: string,
  runId: string
): Promise<RunSnapshot | null> {
  const result = await nova.invoke(RUN_GET_SNAPSHOT, { sessionId, runId })
  return result.snapshot
}

function requestBodies(nova: NovaHarness): string[] {
  return nova.provider.requests.map(request => JSON.stringify(request.body))
}

async function currentSessionId(nova: NovaHarness): Promise<string> {
  const sessionId = (await nova.getWorkspace()).currentSessionId
  if (!sessionId) throw new Error('当前会话缺失')
  return sessionId
}

/** 展开某个已完成轮次的过程树：工具行与子代理活动行默认折叠在「已工作」头内 */
async function expandTurnProcess(nova: NovaHarness, turnText: string): Promise<void> {
  const turn = nova.page
    .getByRole('article', { name: 'Message from assistant' })
    .filter({ hasText: turnText })
  await turn.getByRole('button', { name: /已工作/ }).click()
}

/**
 * 派遣 maxToolRounds=1 的探针并让其撞上限：子代理第一轮发 ls 工具调用即耗尽轮数。
 * 队列顺序：父(task 调用) → 子(ls 调用) → 父(收尾文本)。
 */
async function dispatchProbeUntilRoundLimit(nova: NovaHarness): Promise<ProbeRun> {
  await nova.invoke(SUBAGENTS_CREATE, {
    preset: probePreset(),
    location: 'project',
    workspaceRoot: nova.workspacePath
  })

  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'task',
      arguments: { subagent_type: PRESET_ID, task: INITIAL_TASK },
      callId: 'call_e2e_probe_task'
    },
    {
      kind: 'tool',
      name: 'ls',
      arguments: { path: '.' },
      callId: 'call_e2e_probe_ls'
    },
    { kind: 'text', text: PARENT_TEXT_AFTER_LIMIT }
  )

  await nova.sendPrompt('派遣一个子代理检查工作区根目录')
  await nova.waitUntilIdle()

  const parentSessionId = await currentSessionId(nova)
  const projections = await listProjections(nova, parentSessionId)
  const birth = projections.find(projection => projection.profile.profileId === PRESET_ID)
  if (!birth) throw new Error('撞上限后未产生子代理投影')

  const childRun = await runSnapshot(nova, birth.childSessionId, birth.childRunId)
  expect(childRun?.status).toBe('completed')
  expect(childRun?.incompleteReason).toBe('max_rounds')
  return {
    parentSessionId,
    childSessionId: birth.childSessionId,
    birthRunId: birth.childRunId
  }
}

/** 对撞上限的子会话续跑并自然收尾。队列顺序：父(task_followup 调用) → 子(结论文本) → 父(收尾文本)。 */
async function followupToCompletion(nova: NovaHarness, probe: ProbeRun): Promise<void> {
  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'task_followup',
      arguments: { child_session_id: probe.childSessionId, task: FOLLOWUP_TASK },
      callId: 'call_e2e_probe_followup'
    },
    { kind: 'text', text: CHILD_FINAL_REPORT },
    { kind: 'text', text: PARENT_TEXT_AFTER_FOLLOWUP }
  )

  await nova.sendPrompt('让该子代理带着已有发现继续并给出结论')
  await nova.waitUntilIdle()
}

function childProjections(
  projections: readonly SubagentActivityProjection[],
  childSessionId: string
): SubagentActivityProjection[] {
  return projections
    .filter(projection => projection.childSessionId === childSessionId)
    .sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0))
}

test('撞轮数上限后 followup 带着历史续跑，两个 run 的投影状态各自独立', async ({ nova }) => {
  const probe = await dispatchProbeUntilRoundLimit(nova)

  // 父会话收到的 task 工具结果：含子会话 ID 表头与轮数上限失败文案
  const parentBlocks = toolBlocks(await loadMessages(nova, probe.parentSessionId), 'task')
  expect(parentBlocks).toHaveLength(1)
  expect(parentBlocks[0]!.status).toBe('error')
  expect(parentBlocks[0]!.result ?? '').toContain(`会话 ${probe.childSessionId}`)
  expect(parentBlocks[0]!.result ?? '').toContain(ROUND_LIMIT_ERROR)

  // 父会话内出生 run 的活动行：终态摘要展示轮数上限提示
  await expandTurnProcess(nova, PARENT_TEXT_AFTER_LIMIT)
  const birthRow = nova.page
    .getByRole('button', { name: `子代理 ${PRESET_NAME}` })
    .filter({ hasText: ROUND_LIMIT_NOTICE })
  await expect(birthRow).toBeVisible()
  await expect(birthRow).toContainText('已完成')
  await expect(birthRow).not.toContainText(CHILD_FINAL_REPORT)

  await followupToCompletion(nova, probe)

  // 续跑请求带着全部历史：同一子代理 system prompt + 初始任务 + 上一轮工具结果 + 追加指令
  const followupChildRequest = requestBodies(nova).find(
    body => body.includes(PROBE_PROMPT_MARKER) && body.includes(FOLLOWUP_TASK)
  )
  expect(followupChildRequest).toBeTruthy()
  expect(followupChildRequest!).toContain(INITIAL_TASK)
  expect(followupChildRequest!).toContain('e2e-marker.txt')

  // 父会话收到的 task_followup 工具结果：续跑表头 + 成功
  const followupBlocks = toolBlocks(
    await loadMessages(nova, probe.parentSessionId),
    'task_followup'
  )
  expect(followupBlocks).toHaveLength(1)
  expect(followupBlocks[0]!.status).toBe('success')
  expect(followupBlocks[0]!.result ?? '').toContain(`[子代理续跑 / 会话 ${probe.childSessionId}`)

  // 投影按 run 维度：同一子会话两条投影，runId 互异，状态与摘要互不覆盖
  const projections = childProjections(
    await listProjections(nova, probe.parentSessionId),
    probe.childSessionId
  )
  expect(projections).toHaveLength(2)
  expect(new Set(projections.map(projection => projection.childRunId)).size).toBe(2)
  expect(projections[0]!.childRunId).toBe(probe.birthRunId)
  expect(projections[0]!.status).toBe('completed')
  expect(projections[0]!.summary ?? '').toContain(ROUND_LIMIT_NOTICE)
  expect(projections[1]!.status).toBe('completed')
  expect(projections[1]!.summary ?? '').toContain(CHILD_FINAL_REPORT)
  expect(projections[1]!.summary ?? '').not.toContain(ROUND_LIMIT_NOTICE)

  const secondRun = await runSnapshot(
    nova,
    probe.childSessionId,
    projections[1]!.childRunId
  )
  expect(secondRun?.status).toBe('completed')
  expect(secondRun?.incompleteReason).toBeUndefined()

  // 出生活动行的终态不因续跑被改写；续跑 run 在父会话拥有独立活动行，状态互不覆盖
  await expect(birthRow).toContainText(ROUND_LIMIT_NOTICE)
  await expect(birthRow).not.toContainText(CHILD_FINAL_REPORT)
  await expandTurnProcess(nova, PARENT_TEXT_AFTER_FOLLOWUP)
  const followupRow = nova.page
    .getByRole('button', { name: `子代理 ${PRESET_NAME}` })
    .filter({ hasText: CHILD_FINAL_REPORT })
  await expect(followupRow).toBeVisible()
  await expect(followupRow).toContainText('已完成')
  await expect(followupRow).not.toContainText(ROUND_LIMIT_NOTICE)
})

test('活动行详情弹窗展示子会话跨 run 的连续历史', async ({ nova }) => {
  const probe = await dispatchProbeUntilRoundLimit(nova)
  await followupToCompletion(nova, probe)

  // 权威事实：初始任务、追加指令与工具调用、续跑最终报告
  // 都落在同一个子会话的持久化历史里（跨 run 连续完整）
  const childMessages = await loadMessages(nova, probe.childSessionId)
  const userTexts = childMessages
    .filter(message => message.role === 'user')
    .map(message => message.content)
  expect(userTexts.some(text => text.includes(INITIAL_TASK))).toBe(true)
  expect(userTexts.some(text => text.includes(FOLLOWUP_TASK))).toBe(true)
  expect(toolBlocks(childMessages, 'ls')).toHaveLength(1)
  const childTexts = childMessages.map(message => message.content)
  expect(childTexts.some(text => text.includes(CHILD_FINAL_REPORT))).toBe(true)

  await expandTurnProcess(nova, PARENT_TEXT_AFTER_LIMIT)
  const row = nova.page
    .getByRole('button', { name: `子代理 ${PRESET_NAME}` })
    .filter({ hasText: ROUND_LIMIT_NOTICE })
  await row.click()

  // 弹窗按子会话展示连续历史：出生 run 的工具调用 + 续跑 run 的最终报告
  const popover = nova.page.getByRole('dialog', { name: `${PRESET_NAME} 工作流详情` })
  await expect(popover).toBeVisible()
  await expect(popover.getByText('ls', { exact: true })).toBeVisible()
  await expect(popover).toContainText(CHILD_FINAL_REPORT)

  await popover.getByRole('button', { name: '关闭详情' }).click()
  await expect(popover).toHaveCount(0)
})

test('父会话停止级联取消进行中的 followup', async ({ nova }) => {
  const probe = await dispatchProbeUntilRoundLimit(nova)

  // 续跑时挂起子代理的模型请求，制造可观察的「子执行进行中」状态
  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'task_followup',
      arguments: { child_session_id: probe.childSessionId, task: FOLLOWUP_TASK },
      callId: 'call_e2e_probe_followup_cancel'
    },
    { kind: 'hold', id: 'followup-cascade-hold', text: 'SHOULD_NOT_RENDER' }
  )
  await nova.sendPrompt('让该子代理继续，但我会中途停止')

  // 队列按序消耗到第 5 个请求（父、子、父、父、子）后被 hold 卡住
  await nova.provider.waitForRequestCount(5)
  await expect(nova.page.getByRole('button', { name: '中断生成' })).toBeVisible()

  // run 维度独立性：续跑 run 进行中，出生 run 保持终态
  await expect.poll(async () => {
    const projections = childProjections(
      await listProjections(nova, probe.parentSessionId),
      probe.childSessionId
    )
    return projections.find(projection => projection.childRunId !== probe.birthRunId)?.status ?? ''
  }).toBe('running')
  const midFlight = childProjections(
    await listProjections(nova, probe.parentSessionId),
    probe.childSessionId
  )
  expect(midFlight.find(projection => projection.childRunId === probe.birthRunId)?.status)
    .toBe('completed')

  await nova.page.getByRole('button', { name: '中断生成' }).click()
  await nova.provider.waitForAbortCount(1, 10_000)
  await nova.waitUntilIdle()

  // 父 run 与续跑子 run 均 cancelled；出生 run 不受牵连
  expect((await nova.getRunSnapshot())?.status).toBe('cancelled')
  const projections = childProjections(
    await listProjections(nova, probe.parentSessionId),
    probe.childSessionId
  )
  expect(projections).toHaveLength(2)
  expect(projections.find(projection => projection.childRunId === probe.birthRunId)?.status)
    .toBe('completed')
  const cancelledChildRun = await runSnapshot(
    nova,
    probe.childSessionId,
    projections.find(projection => projection.childRunId !== probe.birthRunId)!.childRunId
  )
  expect(cancelledChildRun?.status).toBe('cancelled')

  // 取消后没有新的模型请求：最后一条（子代理被 hold 的请求）已中断
  expect(nova.provider.requests).toHaveLength(5)
  expect(nova.provider.requests[4]!.aborted).toBe(true)
})

test('renderer reload 后子代理活动行经 IPC 重新水合且无重复', async ({ nova }) => {
  const probe = await dispatchProbeUntilRoundLimit(nova)
  await followupToCompletion(nova, probe)

  await nova.page.reload()
  await expect(nova.page.getByLabel('消息输入')).toBeVisible()

  // 活动行随会话详情（subagentProjections）重新水合：两个 run 各一行、
  // 终态摘要各自正确、无重复行
  await expandTurnProcess(nova, PARENT_TEXT_AFTER_LIMIT)
  await expandTurnProcess(nova, PARENT_TEXT_AFTER_FOLLOWUP)
  const rows = nova.page.getByRole('button', { name: `子代理 ${PRESET_NAME}` })
  await expect(rows).toHaveCount(2)
  await expect(rows.filter({ hasText: ROUND_LIMIT_NOTICE })).toHaveCount(1)
  await expect(rows.filter({ hasText: CHILD_FINAL_REPORT })).toHaveCount(1)
  await expect(nova.page.getByText('正在工作')).toHaveCount(0)
  await expect(nova.page.getByText('等待开始')).toHaveCount(0)

  const projections = childProjections(
    await listProjections(nova, probe.parentSessionId),
    probe.childSessionId
  )
  expect(projections).toHaveLength(2)
  for (const projection of projections) {
    expect(['completed', 'failed', 'cancelled', 'interrupted']).toContain(projection.status)
  }

  expect(nova.pageErrors).toEqual([])
})
