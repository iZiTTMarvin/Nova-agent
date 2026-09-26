import { expect, test } from '../fixtures/nova'
import type { NovaHarness } from '../fixtures/nova'
import { isTerminalRunStatus, type RunSnapshot } from '../../../src/shared/run/types'

const CHECKPOINT_QUESTION = '刷新之后这条记录还在，主要依靠哪一段？'

async function createLearnSession(nova: NovaHarness): Promise<string> {
  const state = await nova.createSession('learn')
  const sessionId = state.currentSessionId
  expect(sessionId).not.toBeNull()
  if (!sessionId) throw new Error('learn session id missing')
  await expect(nova.page.locator('.learning-surface')).toBeVisible()
  return sessionId
}

/** 教练回合：等 run 到达终态 */
async function waitCoachTurnSettled(nova: NovaHarness, sessionId: string): Promise<RunSnapshot | null> {
  await expect
    .poll(
      async () => {
        const snapshot = await nova.getRunSnapshot(sessionId)
        return snapshot == null || isTerminalRunStatus(snapshot.status)
      },
      { timeout: 20_000 }
    )
    .toBe(true)
  return nova.getRunSnapshot(sessionId)
}

async function sendLearningPrompt(nova: NovaHarness, text: string): Promise<void> {
  const input = nova.page.getByLabel('学习提问输入')
  await expect(input).toBeVisible()
  await input.fill(text)
  await nova.page.getByRole('button', { name: '发送学习问题' }).click()
}

/** 读开发输入框内容：兼容受控组件与可编辑容器两种实现。 */
async function readComposerValue(page: NovaHarness['page']): Promise<string> {
  return page.getByLabel('消息输入').evaluate(element => {
    const target = element as HTMLInputElement | HTMLTextAreaElement | HTMLElement
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      ? target.value
      : (target.textContent ?? '')
  })
}

function checkpointToolCall(callId: string): {
  kind: 'tool'
  name: string
  arguments: Record<string, unknown>
  callId: string
} {
  return {
    kind: 'tool',
    name: 'learning_checkpoint',
    arguments: {
      question: CHECKPOINT_QUESTION,
      cursorVersion: 1,
      checkpointId: `ckpt-${callId}`,
      rubric: {
        targetClaim: '指出刷新后数据的来源',
        knowledgeRevision: null,
        verificationMethod: 'open_answer',
        criteria: '能说明刷新后数据从哪读取'
      }
    },
    callId
  }
}

test.describe('学习表面主路径', () => {
  test('进入学习不改动开发会话，树与空状态可辨', async ({ nova }) => {
    test.setTimeout(90_000)
    const devWorkspace = await nova.getWorkspace()
    const devSessionId = devWorkspace.currentSessionId
    expect(devSessionId).not.toBeNull()
    expect(devWorkspace.currentMode).toBe('default')

    const learnSessionId = await createLearnSession(nova)

    // 开发会话仍是 default，没有被原地改成 learn
    const sessions = await nova.page.evaluate(async () => {
      const api = (window as typeof window & { api?: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } }).api
      return api!.invoke('load-sessions') as Promise<Array<{ id: string; mode: string }>>
    })
    const devSession = sessions.find(session => session.id === devSessionId)
    expect(devSession?.mode).toBe('default')
    expect(sessions.some(session => session.id === learnSessionId && session.mode === 'learn')).toBe(true)

    // 学习表面：分段切换、知识导航骨架、空对话状态
    await expect(nova.page.getByRole('button', { name: '学习' }).first()).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await expect(nova.page.locator('.learning-surface__nav')).toBeVisible()
    await expect(nova.page.getByText('项目用途', { exact: false })).toBeVisible()
    await expect(nova.page.locator('.learning-tree__empty')).toBeVisible()
    await expect(nova.page.locator('.learning-conversation--empty')).toBeVisible()
    await expect(nova.page.getByRole('button', { name: '帮我选一个起点' })).toBeVisible()
    await expect(nova.page.getByRole('button', { name: '返回开发' })).toBeVisible()
  })

  test('教练讲解后落停点，回答保存待评估', async ({ nova }) => {
    test.setTimeout(120_000)
    const sessionId = await createLearnSession(nova)

    // 教练回合：调用 learning_checkpoint 落停点后本轮即结束（turn_complete）
    nova.provider.enqueue(checkpointToolCall('call_ckpt_e2e'))

    await sendLearningPrompt(nova, '数据保存后刷新为什么还在？')

    // 生成中状态可辨：取消入口出现
    await expect(nova.page.getByRole('button', { name: '取消本轮教练生成' })).toBeVisible()
    await waitCoachTurnSettled(nova, sessionId)

    // 停点可见：问题 + 三个平级操作
    const checkpoint = nova.page.locator('.learning-checkpoint')
    await expect(checkpoint).toBeVisible()
    await expect(checkpoint).toContainText(CHECKPOINT_QUESTION)
    await expect(checkpoint).toContainText('等待回答')
    for (const label of ['提示', '直接讲解', '跳过']) {
      await expect(nova.page.getByRole('button', { name: label, exact: true })).toBeEnabled()
    }

    // 提示操作：发起一次新教练回合
    nova.provider.enqueue({ kind: 'text', text: 'HINT_AFTER_ASK' })
    await nova.page.getByRole('button', { name: '提示', exact: true }).click()
    await expect(nova.page.getByText('HINT_AFTER_ASK', { exact: false })).toBeVisible()
    await waitCoachTurnSettled(nova, sessionId)

    // 回答 → attempt 落库 → 交接新回合；停点变为「回答已保存，等待评估」
    nova.provider.enqueue({ kind: 'text', text: 'ASSESS_TURN_PENDING' })
    await nova.page.getByLabel('核对点回答').fill('应该是加载时重新查了数据库')
    await nova.page.getByRole('button', { name: '提交回答' }).click()
    await expect(nova.page.getByText('ASSESS_TURN_PENDING', { exact: false })).toBeVisible()
    await waitCoachTurnSettled(nova, sessionId)
    await expect(nova.page.locator('.learning-checkpoint--settled')).toContainText('回答已保存，等待评估')

    expect(nova.pageErrors).toEqual([])
  })

  test('教练生成中可取消，取消后可继续学习', async ({ nova }) => {
    test.setTimeout(120_000)
    const sessionId = await createLearnSession(nova)

    nova.provider.enqueue({ kind: 'hold', id: 'learning-hold', text: 'SHOULD_NOT_RENDER' })
    await sendLearningPrompt(nova, '先讲个不停的话题')

    const cancelButton = nova.page.getByRole('button', { name: '取消本轮教练生成' })
    await expect(cancelButton).toBeVisible()
    await cancelButton.click()
    await nova.provider.waitForAbortCount(1, 15_000)
    await waitCoachTurnSettled(nova, sessionId)
    await expect(nova.page.getByText('SHOULD_NOT_RENDER', { exact: false })).toHaveCount(0)
    await expect(nova.page.getByRole('button', { name: '发送学习问题' })).toBeVisible()

    // 取消后仍可继续：新一轮正常完成
    nova.provider.enqueue({ kind: 'text', text: 'LEARN_AFTER_CANCEL' })
    await sendLearningPrompt(nova, '换个话题')
    await expect(nova.page.getByText('LEARN_AFTER_CANCEL', { exact: false })).toBeVisible()
    await waitCoachTurnSettled(nova, sessionId)
    expect(nova.pageErrors).toEqual([])
  })

  test('学习会话切换、reload 与重复 reload 后停点与消息可恢复', async ({ nova }) => {
    test.setTimeout(150_000)
    const firstSessionId = await createLearnSession(nova)

    nova.provider.enqueue(checkpointToolCall('call_ckpt_reload'))
    await sendLearningPrompt(nova, '数据保存后刷新为什么还在？')
    await waitCoachTurnSettled(nova, firstSessionId)
    await expect(nova.page.locator('.learning-checkpoint')).toContainText(CHECKPOINT_QUESTION)

    // 新建第二个学习会话：第一个会话内容不串到第二个
    const secondSessionId = await createLearnSession(nova)
    expect(secondSessionId).not.toBe(firstSessionId)
    await expect(nova.page.locator('.learning-checkpoint')).toHaveCount(0)
    await expect(
      nova.page.locator('.learning-conversation').getByText('数据保存后刷新为什么还在？', { exact: false })
    ).toHaveCount(0)
    await expect(nova.page.locator('.learning-conversation--empty')).toBeVisible()

    // 切回第一个会话：停点与消息从持久化恢复
    await nova.selectSession(firstSessionId)
    await expect(nova.page.locator('.learning-checkpoint')).toContainText(CHECKPOINT_QUESTION)
    await expect(
      nova.page.locator('.learning-conversation').getByText('数据保存后刷新为什么还在？', { exact: false })
    ).toBeVisible()

    // reload 与重复 reload：重新水合，监听器不叠加
    for (let index = 0; index < 2; index++) {
      await nova.page.reload()
      await expect(nova.page.locator('.learning-surface')).toBeVisible()
      await expect(nova.page.locator('.learning-checkpoint')).toContainText(CHECKPOINT_QUESTION)
      await expect(
      nova.page.locator('.learning-conversation').getByText('数据保存后刷新为什么还在？', { exact: false })
    ).toBeVisible()
      await expect(nova.page.getByLabel('学习提问输入')).toBeVisible()
    }
    expect(nova.pageErrors).toEqual([])
  })

  test('返回开发恢复原会话与草稿，学懂这次改动回到学习', async ({ nova }) => {
    test.setTimeout(150_000)
    const devWorkspace = await nova.getWorkspace()
    const devSessionId = devWorkspace.currentSessionId
    expect(devSessionId).not.toBeNull()
    if (!devSessionId) throw new Error('dev session id missing')

    // 开发面留一段草稿
    await nova.page.getByLabel('消息输入').fill('DEV_DRAFT_KEEP_ME')

    const learnSessionId = await createLearnSession(nova)

    // 返回开发：原开发会话恢复，草稿仍在
    await nova.page.getByRole('button', { name: '返回开发' }).click()
    await expect(nova.page.getByLabel('消息输入')).toBeVisible()
    expect(await readComposerValue(nova.page)).toContain('DEV_DRAFT_KEEP_ME')
    const backWorkspace = await nova.getWorkspace()
    expect(backWorkspace.currentSessionId).toBe(devSessionId)
    expect(backWorkspace.currentMode).toBe('default')

    // 开发结果旁的「学懂这次改动」入口
    nova.provider.enqueue({ kind: 'text', text: 'DEV_CHANGE_SUMMARY_TEXT' })
    await nova.sendPrompt('改一下保存入口')
    await nova.waitUntilIdle()
    await expect(nova.page.getByText('DEV_CHANGE_SUMMARY_TEXT', { exact: false })).toBeVisible()

    const learnEntry = nova.page.getByRole('button', { name: '学懂这次改动' })
    await expect(learnEntry).toBeVisible()
    // 教练回合在点击时即发起：响应必须先入队
    nova.provider.enqueue({ kind: 'text', text: 'DEV_LINK_COACH_REPLY' })
    await learnEntry.click()

    // 进入学习表面并自动发起带出处的教练回合
    await expect(nova.page.locator('.learning-surface')).toBeVisible()
    const switchedWorkspace = await nova.getWorkspace()
    expect(switchedWorkspace.currentSessionId).toBe(learnSessionId)
    await expect(nova.page.getByText('DEV_LINK_COACH_REPLY', { exact: false })).toBeVisible()
    await waitCoachTurnSettled(nova, learnSessionId)
    // 教练回合携带了来源引用，而不是复制整段历史；内部 ID 不进用户可见消息
    await expect(nova.page.locator('.learning-msg--user').last()).toContainText('这次改动')
    await expect(nova.page.locator('.learning-msg--user').last()).not.toContainText(devSessionId!)
    expect(nova.pageErrors).toEqual([])
  })

  test('教练生成中提交回答被拒，原状态与草稿保留', async ({ nova }) => {
    test.setTimeout(150_000)
    const sessionId = await createLearnSession(nova)

    nova.provider.enqueue(checkpointToolCall('call_ckpt_busy'))
    await sendLearningPrompt(nova, '数据保存后刷新为什么还在？')
    await waitCoachTurnSettled(nova, sessionId)

    // 提示会启动一次新教练回合；让该回合 hold 住，制造教练生成中窗口
    nova.provider.enqueue({ kind: 'hold', id: 'learning-busy-hold', text: 'HOLDING_HINT' })
    await nova.page.getByRole('button', { name: '提示', exact: true }).click()

    // UI 在生成中会禁用提交；绕过 UI 直接提交结构化回答，验证服务端接纳层拒绝
    const receipt = await nova.page.evaluate(async (sid: string) => {
      const api = (window as typeof window & { api?: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } }).api
      const surface = (await api!.invoke('learning:get-surface', { sessionId: sid })) as {
        clearGeneration: number
        cursorVersion: number
        checkpoint: { checkpointId: string }
      }
      return api!.invoke('learning:command', {
        sessionId: sid,
        command: {
          commandId: 'e2e-busy-answer',
          sessionId: sid,
          expectedClearGeneration: surface.clearGeneration,
          expectedCursorVersion: surface.cursorVersion,
          action: {
            type: 'answer',
            checkpointId: surface.checkpoint.checkpointId,
            text: '生成中尝试提交的回答',
            optionIds: []
          }
        }
      }) as Promise<{ ok: boolean; code: string }>
    }, sessionId)
    expect(receipt.ok).toBe(false)
    expect(receipt.code).toBe('busy')

    // 停点未被消费，仍等待回答；输入草稿不受影响
    await expect(nova.page.locator('.learning-checkpoint')).toContainText('等待回答')

    // 取消挂住的教练回合后，同一回答可以从 UI 正常提交
    await nova.page.getByRole('button', { name: '取消本轮教练生成' }).click()
    await nova.provider.waitForAbortCount(1, 15_000)
    await waitCoachTurnSettled(nova, sessionId)
    nova.provider.enqueue({ kind: 'text', text: 'BUSY_RETRY_ASSESS_DONE' })
    await nova.page.getByLabel('核对点回答').fill('取消后重新提交的回答')
    await nova.page.getByRole('button', { name: '提交回答' }).click()
    await expect(nova.page.locator('.learning-checkpoint--settled')).toContainText('回答已保存，等待评估')
    // 「继续评估」入口在回答待评估时出现
    await expect(nova.page.getByRole('button', { name: '继续评估上次回答' })).toBeVisible()
    expect(nova.pageErrors).toEqual([])
  })
})
