/**
 * 后台子代理生命周期：后台接纳立即归还父执行权 → 空闲接力送达通知 →
 * task_wait 显式等待与子代理交互 → 父空闲单独停止 → 真实进程重启后的结果找回 →
 * 同步 batch 一成一中断的崩溃恢复与显式继续。
 *
 * 父子会话共用 fake provider，但通过 enqueueLane 按请求体标记路由成两条独立回合队列：
 * 父回合顺序与子回合顺序各自确定，配合 hold 屏障把通知到达时机控制
 * 在 final answer / 停止 / 重启之间，不用 sleep 掩盖竞态。
 */
import { exec } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  LOAD_SESSION_MESSAGES,
  RUN_GET_SNAPSHOT,
  SAVE_MODEL_CONFIG,
  SUBAGENTS_CREATE,
  SUBAGENT_LIST_PROJECTIONS,
  WORKSPACE_SET_PERMISSION_MODE
} from '../../../src/shared/ipc/channels'
import type { Message, MessageBlock } from '../../../src/shared/session/types'
import type { SubAgentSpec } from '../../../src/shared/settings/types'
import type { SubagentActivityProjection } from '../../../src/shared/subagents'
import type { RunSnapshot } from '../../../src/shared/run/types'
import { expect, launchNova, test, type NovaHarness } from '../fixtures/nova'

const PARENT_TEXT_AFTER_SPAWN = 'NOVA_E2E_BG_PARENT_AFTER_SPAWN'
const RELAY_ANSWER = 'NOVA_E2E_BG_RELAY_ANSWER'
const CHILD_REPORT = 'NOVA_E2E_BG_CHILD_REPORT'
const PARENT_TEXT_AFTER_WAIT = 'NOVA_E2E_BG_PARENT_AFTER_WAIT'
const CHILD_REPORT_AFTER_APPROVAL = 'NOVA_E2E_BG_CHILD_REPORT_APPROVED'
const CHILD_A_REPORT = 'NOVA_E2E_BATCH_CHILD_A_REPORT'
const AFTER_RESTART_ANSWER = 'NOVA_E2E_BG_AFTER_RESTART_ANSWER'
const PARENT_AFTER_RESUME = 'NOVA_E2E_BG_PARENT_AFTER_RESUME'
const CHILD_B_RESUMED_REPORT = 'NOVA_E2E_BATCH_CHILD_B_RESUMED_REPORT'

type ToolBlockView = Extract<MessageBlock, { type: 'tool' }>

interface ProbePreset {
  readonly id: string
  readonly name: string
  readonly marker: string
}

function bgPreset(suffix: string, marker: string, allowedTools: string[]): ProbePreset & { spec: SubAgentSpec } {
  const id = `e2e-bg-${suffix}`
  const name = `E2E 后台探针 ${suffix.toUpperCase()}`
  return {
    id,
    name,
    marker,
    spec: {
      id,
      name,
      description: '后台子代理生命周期验证探针',
      enabled: true,
      allowedTools,
      prompt: `${marker} 检查工作区并汇报结论。`,
      maxToolRounds: 4
    }
  }
}

async function createPreset(
  nova: NovaHarness,
  spec: SubAgentSpec
): Promise<void> {
  await nova.invoke(SUBAGENTS_CREATE, {
    preset: spec,
    location: 'project',
    workspaceRoot: nova.workspacePath
  })
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

function messageTexts(messages: readonly Message[]): string[] {
  return messages.map(message => JSON.stringify(message.blocks ?? message.content))
}

async function currentSessionId(nova: NovaHarness): Promise<string> {
  const sessionId = (await nova.getWorkspace()).currentSessionId
  if (!sessionId) throw new Error('当前会话缺失')
  return sessionId
}

async function runSnapshot(
  nova: NovaHarness,
  sessionId: string,
  runId: string
): Promise<RunSnapshot | null> {
  const result = await nova.invoke(RUN_GET_SNAPSHOT, { sessionId, runId })
  return result.snapshot
}

async function expandTurnProcess(nova: NovaHarness, turnText: string): Promise<void> {
  const turn = nova.page
    .getByRole('article', { name: 'Message from assistant' })
    .filter({ hasText: turnText })
  await turn.getByRole('button', { name: /已工作/ }).click()
}

interface BgDispatch {
  readonly parentSessionId: string
  readonly childSessionId: string
  readonly childRunId: string
}

/** 派遣后台探针并等父 turn 完成；子代理被 hold 屏障卡在运行中。 */
async function dispatchBackgroundChild(
  nova: NovaHarness,
  preset: ProbePreset & { spec: SubAgentSpec },
  holdId: string
): Promise<BgDispatch> {
  await createPreset(nova, preset.spec)
  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'task',
      arguments: { subagent_type: preset.id, task: 'NOVA_E2E_BG_TASK 检查根目录', background: true },
      callId: 'call_bg_spawn'
    },
    { kind: 'text', text: PARENT_TEXT_AFTER_SPAWN }
  )
  nova.provider.enqueueLane(preset.marker, { kind: 'hold', id: holdId, text: CHILD_REPORT })

  await nova.sendPrompt('后台派遣子代理检查根目录，先继续别的事')
  await nova.waitUntilIdle()

  const parentSessionId = await currentSessionId(nova)
  const birth = (await listProjections(nova, parentSessionId)).find(
    projection => projection.profile.profileId === preset.id
  )
  if (!birth) throw new Error('后台派遣后未产生子代理投影')
  return {
    parentSessionId,
    childSessionId: birth.childSessionId,
    childRunId: birth.childRunId
  }
}

/** 关闭主进程（走 will-quit 落盘路径），供同 profile 重启 */
async function quitGracefully(nova: NovaHarness): Promise<void> {
  const proc = nova.app.process()
  const closed = nova.app.waitForEvent('close', { timeout: 30_000 }).catch(() => undefined)
  await nova.app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined)
  await nova.app.close().catch(() => undefined)
  await closed
  try {
    proc.kill()
  } catch {
    // 进程已退出，句柄失效
  }
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && proc.exitCode === null) {
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

/** 强杀主进程模拟崩溃：绕过 will-quit，非终态 run 原样落盘供重启对账 */
async function crashAndRelaunch(
  nova: NovaHarness,
  testInfo: Parameters<typeof launchNova>[0],
  options: { skipWorkspaceSetup?: boolean } = {}
): Promise<NovaHarness> {
  const proc = nova.app.process()
  // 树杀：Windows 上仅杀主进程时，残留子进程可能继续持有单实例锁
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      exec(`taskkill /pid ${proc.pid} /T /F`, () => resolve())
    })
  } else {
    proc.kill('SIGKILL')
  }
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && proc.exitCode === null && proc.signalCode === null) {
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return launchNova(testInfo, options, {
    profileRoot: nova.profileRoot,
    workspacePath: nova.workspacePath,
    provider: nova.provider
  })
}

test('后台接纳立即归还父执行权；父结束后空闲接力自动送达通知', async ({ nova }) => {
  const preset = bgPreset('relay', 'NOVA_E2E_BG_PROBE_RELAY_MARKER', ['ls'])
  const dispatch = await dispatchBackgroundChild(nova, preset, 'bg-relay-hold')

  // 父执行权已归还：最终回答可见，后台 child 仍在运行（accepted 不伪装完成）
  const birth = (await listProjections(nova, dispatch.parentSessionId)).find(
    projection => projection.childRunId === dispatch.childRunId
  )
  expect(birth?.execution).toBe('background_read_only')
  const midRun = await runSnapshot(nova, dispatch.childSessionId, dispatch.childRunId)
  expect(['running', 'queued']).toContain(midRun?.status ?? '')

  await expandTurnProcess(nova, PARENT_TEXT_AFTER_SPAWN)
  const row = nova.page.getByRole('button', { name: `子代理 ${preset.name}` })
  await expect(row).toContainText('正在工作')
  await expect(row).not.toContainText('已完成')
  // 父空闲但 child 活跃：行内保留停止入口
  await expect(nova.page.getByRole('button', { name: '停止后台任务' })).toBeVisible()
  expect(nova.provider.requests).toHaveLength(3)

  // 释放屏障：child 完成 → 空闲接力自动开父 turn 消费通知
  nova.provider.enqueue({ kind: 'text', text: RELAY_ANSWER })
  nova.provider.release('bg-relay-hold')
  await nova.provider.waitForRequestCount(4)
  await nova.waitUntilIdle()

  await expect(nova.page.getByText(RELAY_ANSWER, { exact: false })).toBeVisible()
  // 接力请求的 wire 携带冻结的通知正文
  expect(JSON.stringify(nova.provider.requests[3]!.body)).toContain(CHILD_REPORT)

  const done = (await listProjections(nova, dispatch.parentSessionId)).find(
    projection => projection.childRunId === dispatch.childRunId
  )
  expect(done?.status).toBe('completed')
  expect(done?.summary ?? '').toContain(CHILD_REPORT)

  // 通知不重复投递：无第 5 次请求
  await nova.waitUntilIdle()
  expect(nova.provider.requests).toHaveLength(4)
  expect(nova.pageErrors).toEqual([])
})

test('task_wait 显式等待返回 waiting_user；父界面交互入口批准后子任务完成并接力', async ({ nova }) => {
  const preset = bgPreset('wait', 'NOVA_E2E_BG_PROBE_WAIT_MARKER', ['read'])
  const sessionId = await currentSessionId(nova)
  await nova.invoke(WORKSPACE_SET_PERMISSION_MODE, { sessionId, permissionMode: 'request_approval' })

  // 工作区外的可读文件：request_approval 下外部路径读取会向用户请求授权
  const externalPath = path.join(nova.profileRoot, 'home', 'external-note.txt')
  await writeFile(externalPath, 'NOVA_E2E_EXTERNAL_NOTE_CONTENT', 'utf8')

  await createPreset(nova, preset.spec)
  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'task',
      arguments: { subagent_type: preset.id, task: 'NOVA_E2E_WAIT_TASK 读取外部说明', background: true },
      callId: 'call_wait_spawn'
    },
    {
      kind: 'tool',
      name: 'task_wait',
      arguments: { all_unfinished: true, timeout_ms: 30_000 },
      callId: 'call_bg_wait'
    },
    { kind: 'text', text: PARENT_TEXT_AFTER_WAIT }
  )
  nova.provider.enqueueLane(
    preset.marker,
    { kind: 'tool', name: 'read', arguments: { path: externalPath }, callId: 'call_bg_read' },
    { kind: 'text', text: CHILD_REPORT_AFTER_APPROVAL }
  )

  await nova.sendPrompt('后台派遣子代理读取外部说明，并等待它需要处理的事情')
  await nova.waitUntilIdle()

  // task_wait 及时返回 waiting_user，不把子交互伪造成完成
  const waitBlocks = toolBlocks(await loadMessages(nova, sessionId), 'task_wait')
  expect(waitBlocks).toHaveLength(1)
  expect(waitBlocks[0]!.status).toBe('success')
  expect(waitBlocks[0]!.result ?? '').toContain('waiting_user')

  // 子代理活动行显示等待授权，权限条锚定到对应行并展示待授权路径
  await expandTurnProcess(nova, PARENT_TEXT_AFTER_WAIT)
  const row = nova.page.getByRole('button', { name: `子代理 ${preset.name}` })
  await expect(row).toContainText('等待授权')
  const permBar = nova.page.locator('.subagent-activity-row__permission')
  await expect(permBar).toBeVisible()
  await expect(permBar).toContainText('external-note.txt')

  // 批准 → 子任务继续并完成 → 空闲接力送达通知
  nova.provider.enqueue({ kind: 'text', text: RELAY_ANSWER })
  await nova.page.locator('.inline-perm__btn--allow').click()
  await nova.provider.waitForRequestCount(6)
  await nova.waitUntilIdle()

  expect(JSON.stringify(nova.provider.requests[5]!.body)).toContain(CHILD_REPORT_AFTER_APPROVAL)
  const projections = (await listProjections(nova, sessionId)).find(
    projection => projection.profile.profileId === preset.id
  )
  expect(projections?.status).toBe('completed')
  expect(projections?.summary ?? '').toContain(CHILD_REPORT_AFTER_APPROVAL)
  expect(nova.pageErrors).toEqual([])
})

test('父空闲可单独停止后台子代理；连点不重复取消，取消前内容保留', async ({ nova }) => {
  const preset = bgPreset('stop', 'NOVA_E2E_BG_PROBE_STOP_MARKER', ['ls'])
  const dispatch = await dispatchBackgroundChild(nova, preset, 'bg-stop-hold')

  await expandTurnProcess(nova, PARENT_TEXT_AFTER_SPAWN)
  const stop = nova.page.getByRole('button', { name: '停止后台任务' })
  await expect(stop).toBeVisible()
  // 连点：第二次点击可能因状态翻转落空，不得造成重复取消或报错
  await Promise.allSettled([stop.click(), stop.click()])

  await nova.provider.waitForAbortCount(1, 10_000)
  await nova.waitUntilIdle()

  // 被停的是后台 child；父 turn 与其他内容不受牵连
  const cancelled = await runSnapshot(nova, dispatch.childSessionId, dispatch.childRunId)
  expect(cancelled?.status).toBe('cancelled')

  // 面板已在点击停止前展开，保持展开状态验证行状态翻转
  const row = nova.page.getByRole('button', { name: `子代理 ${preset.name}` })
  await expect(row).toContainText('已取消')
  await expect(nova.page.getByRole('button', { name: '停止后台任务' })).toHaveCount(0)
  // 取消前的工具记录与接纳表头保留
  const taskBlock = toolBlocks(await loadMessages(nova, dispatch.parentSessionId), 'task')
  expect(taskBlock[0]!.result ?? '').toContain(`会话 ${dispatch.childSessionId}`)

  // reload 后行状态保持、无重复行；被停止的通知不触发接力
  await nova.page.reload()
  await expect(nova.page.getByLabel('消息输入')).toBeVisible()
  await expandTurnProcess(nova, PARENT_TEXT_AFTER_SPAWN)
  await expect(nova.page.getByRole('button', { name: `子代理 ${preset.name}` })).toHaveCount(1)
  await expect(nova.page.getByRole('button', { name: `子代理 ${preset.name}` })).toContainText('已取消')
  expect(nova.provider.requests).toHaveLength(3)
  expect(nova.pageErrors).toEqual([])
})

test('真实进程重启后已保存的完成通知不丢失、不重复投递', async ({ nova }, testInfo) => {
  const preset = bgPreset('restart', 'NOVA_E2E_BG_PROBE_RESTART_MARKER', ['ls'])
  const dispatch = await dispatchBackgroundChild(nova, preset, 'bg-restart-hold')

  // 释放屏障让 child 完成；接力预约持久化后，接力 turn 的模型请求被屏障卡住
  nova.provider.enqueue({ kind: 'hold', id: 'bg-relay-request-hold', text: 'SHOULD_NOT_FINISH' })
  nova.provider.release('bg-restart-hold')
  await nova.provider.waitForRequestCount(4)

  // 退出前通知事实已随接力消息持久化
  const before = messageTexts(await loadMessages(nova, dispatch.parentSessionId))
  expect(before.filter(text => text.includes(CHILD_REPORT))).toHaveLength(1)

  await quitGracefully(nova)
  const resumed = await launchNova(testInfo, {}, {
    profileRoot: nova.profileRoot,
    workspacePath: nova.workspacePath,
    provider: nova.provider
  })
  try {
    await resumed.selectSession(dispatch.parentSessionId)

    // 结果找回：通知事实仍在父会话且恰好一份；接力 turn 中断待用户继续，不自动重跑
    const after = messageTexts(await loadMessages(resumed, dispatch.parentSessionId))
    expect(after.filter(text => text.includes(CHILD_REPORT))).toHaveLength(1)
    await expect.poll(async () => (await resumed.getRunSnapshot(dispatch.parentSessionId))?.status)
      .toBe('interrupted')
    expect(resumed.provider.requests).toHaveLength(4)

    // 用户正常继续：新轮次正常执行，通知不再重复注入
    resumed.provider.enqueue({ kind: 'text', text: AFTER_RESTART_ANSWER })
    await resumed.sendPrompt('继续刚才的话题')
    await resumed.waitUntilIdle()
    await expect(resumed.page.getByText(AFTER_RESTART_ANSWER, { exact: false })).toBeVisible()
    const final = messageTexts(await loadMessages(resumed, dispatch.parentSessionId))
    expect(final.filter(text => text.includes(CHILD_REPORT))).toHaveLength(1)
    expect(resumed.provider.requests).toHaveLength(5)
    expect(resumed.pageErrors).toEqual([])
  } finally {
    await resumed.cleanup()
  }
})

test('崩溃中断的同步 batch 一成一中断；重启精确结算不借用其他 run 输出', async ({ nova }, testInfo) => {
  const presetA = bgPreset('batch-a', 'NOVA_E2E_BATCH_PROBE_A_MARKER', ['ls'])
  const presetB = bgPreset('batch-b', 'NOVA_E2E_BATCH_PROBE_B_MARKER', ['ls'])
  await createPreset(nova, presetA.spec)
  await createPreset(nova, presetB.spec)

  nova.provider.enqueue({
    kind: 'tool',
    name: 'batch_task',
    arguments: {
      items: [
        { itemId: 'item-a', profileId: presetA.id, task: 'NOVA_E2E_BATCH_TASK_A' },
        { itemId: 'item-b', profileId: presetB.id, task: 'NOVA_E2E_BATCH_TASK_B' }
      ]
    },
    callId: 'call_batch_spawn'
  })
  nova.provider.enqueueLane(presetA.marker, { kind: 'text', text: CHILD_A_REPORT })
  nova.provider.enqueueLane(presetB.marker, { kind: 'hold', id: 'batch-b-hold', text: 'SHOULD_NOT_FINISH' })

  await nova.sendPrompt('并行派遣两个子代理检查')
  await nova.provider.waitForRequestCount(3)

  const parentSessionId = await currentSessionId(nova)
  // 等 A 项真实完成再崩溃，保证落盘事实是「一成一执行中」
  await expect.poll(async () => {
    const projections = await listProjections(nova, parentSessionId)
    return projections.find(projection => projection.profile.profileId === presetA.id)?.status ?? ''
  }).toBe('completed')
  const crashed = await crashAndRelaunch(nova, testInfo)
  try {
    await crashed.selectSession(parentSessionId)

    // 启动对账：父 run interrupted；batch 工具块精确结算，两项互不借用结果
    await expect(crashed.page.getByText('任务意外中断', { exact: false })).toBeVisible()
    const batchBlocks = toolBlocks(await loadMessages(crashed, parentSessionId), 'batch_task')
    expect(batchBlocks).toHaveLength(1)
    const batchResult = batchBlocks[0]!.result ?? ''
    expect(batchResult).toContain(CHILD_A_REPORT)
    expect(batchResult).toContain('interrupted')

    // 两个 batch 项各自的 run 状态互不覆盖：A 完成保持，B 中断待继续
    const projections = await listProjections(crashed, parentSessionId)
    expect(projections.find(projection => projection.profile.profileId === presetA.id)?.status)
      .toBe('completed')
    expect(projections.find(projection => projection.profile.profileId === presetB.id)?.status)
      .toBe('interrupted')
    expect(new Set(projections.map(projection => projection.childRunId)).size).toBe(2)
    expect(crashed.pageErrors).toEqual([])
  } finally {
    await crashed.cleanup()
  }
})

test('崩溃中断的同步子代理重启后精确结算；继续入口不伪装已执行，模型失效明确报错', async ({ nova }, testInfo) => {
  const preset = bgPreset('resume', 'NOVA_E2E_RESUME_PROBE_MARKER', ['ls'])
  await createPreset(nova, preset.spec)

  // 同步 task 派遣后子代理被屏障卡住，父 turn 阻塞在工具执行中；崩溃保留两侧非终态
  nova.provider.enqueue({
    kind: 'tool',
    name: 'task',
    arguments: { subagent_type: preset.id, task: 'NOVA_E2E_RESUME_TASK 检查根目录' },
    callId: 'call_sync_task'
  })
  nova.provider.enqueueLane(preset.marker, { kind: 'hold', id: 'resume-crash-hold', text: 'SHOULD_NOT_FINISH' })

  await nova.sendPrompt('派遣子代理检查根目录')
  await nova.provider.waitForRequestCount(2)

  const parentSessionId = await currentSessionId(nova)
  // 跳过重写模型配置：child header 冻结了 model entry id，重启不得重生成注册表
  const crashed = await crashAndRelaunch(nova, testInfo, { skipWorkspaceSetup: true })
  try {
    await crashed.selectSession(parentSessionId)

    // 启动对账：父 run 与 child run 均收敛 interrupted；task 工具块精确结算且不转圈
    await expect(crashed.page.getByText('任务意外中断', { exact: false })).toBeVisible()
    const projections = await listProjections(crashed, parentSessionId)
    const interruptedChild = projections.find(
      projection => projection.profile.profileId === preset.id
    )
    expect(interruptedChild?.status).toBe('interrupted')
    const taskBlocks = toolBlocks(await loadMessages(crashed, parentSessionId), 'task')
    expect(taskBlocks).toHaveLength(1)
    expect(taskBlocks[0]!.status).not.toBe('success')
    expect(taskBlocks[0]!.result ?? '').toContain(`会话 ${interruptedChild!.childSessionId}`)

    // 继续入口点击后走父消息入口；本隔离 profile 重启后持久化 API Key 密文跨进程不可解，
    // 父侧模型客户端缺失 → 提交必须如实失败：不创建父 run、不发请求，行内给出重试入口，
    // 不把「已提交」伪装成「子任务已恢复」
    await crashed.page.getByRole('button', { name: '继续此子任务' }).first().click()
    const retry = crashed.page.getByRole('button', { name: /重试/ }).first()
    await expect(retry).toBeVisible()
    expect(crashed.provider.requests).toHaveLength(2)
    expect((await crashed.getRunSnapshot(parentSessionId))?.status).toBe('interrupted')

    // 重建模型客户端后重试：新保存会重生成 model entry id，与 child 冻结 header 失配 →
    // 续跑按设计明确失败（不自动换模型），父会话收到可读错误，child 保持 interrupted
    await crashed.invoke(SAVE_MODEL_CONFIG, {
      baseUrl: nova.provider.baseUrl,
      apiKey: 'nova-e2e-key',
      modelId: 'nova-e2e-model',
      cacheProfile: 'generic',
      toolDialect: 'native'
    })

    crashed.provider.enqueue(
      {
        kind: 'tool',
        name: 'task_followup',
        arguments: {
          child_session_id: interruptedChild!.childSessionId,
          resume_run_id: interruptedChild!.childRunId,
          task: 'NOVA_E2E_RESUME_TASK 继续'
        },
        callId: 'call_sync_resume'
      },
      { kind: 'text', text: PARENT_AFTER_RESUME }
    )

    await retry.click()
    await crashed.provider.waitForRequestCount(4)
    await crashed.waitUntilIdle()

    const followupBlocks = toolBlocks(await loadMessages(crashed, parentSessionId), 'task_followup')
    expect(followupBlocks).toHaveLength(1)
    expect(followupBlocks[0]!.status).toBe('error')
    expect(followupBlocks[0]!.result ?? '').toContain('不可用')
    // child 不伪装恢复：仍为 interrupted，且未出现 resumedFromRunId 的新 run
    const afterProjections = await listProjections(crashed, parentSessionId)
    expect(afterProjections.find(p => p.profile.profileId === preset.id)?.status).toBe('interrupted')
    expect(afterProjections.some(p => p.resumedFromRunId === interruptedChild!.childRunId)).toBe(false)
    expect(crashed.pageErrors).toEqual([])
  } finally {
    await crashed.cleanup()
  }
})
