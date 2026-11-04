import type { Frame, Locator } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '../fixtures/nova'
import type { NovaHarness } from '../fixtures/nova'
import {
  CHECKPOINT_QUESTION,
  checkpointToolTurn,
  createLearnSession,
  expectNoInstructionLeak,
  expectSingleLearningInput,
  fillLearningAnswer,
  installOutlineBuildFailure,
  installOutlineBuildHold,
  installOutlineBuildSuccess,
  learningDock,
  learningMain,
  learningFlow,
  learningEmptyHeading,
  openOutlinePane,
  outlineTopicRow,
  readEditableValue,
  sendLearningPrompt,
  waitLearnTurnSettled,
  writeSampleCode,
  type OutlineBuildInfo
} from './learningFlow'

async function contentFrameOf(frame: Locator): Promise<Frame> {
  const handle = await frame.elementHandle()
  const content = await handle?.contentFrame()
  if (!content) throw new Error('可视化帧尚未挂载')
  return content
}

function userTexts(body: Record<string, unknown>): string[] {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string; content?: unknown }>) : []
  return messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content ?? ''))
}

/** 生成期的预览帧垫在正式帧上方，正式帧就绪后淡出卸载；退场后卡片里只剩正式帧 */
async function settledFrame(card: Locator): Promise<Locator> {
  await expect(card.getByTestId('visualization-preview')).toHaveCount(0)
  return card.getByTestId('visualization-frame')
}

const LEARN_VIZ_DRAFT = `## 学习架构图

\`\`\`ask id=explore-module
想继续看哪个模块？
深入讲讲 | 深入讲讲 E2E 模块
\`\`\``

test.describe('学习表面主路径', () => {
  test('探索后思考与正文在回合结束前持续显示，完成后不重复', async ({ nova }) => {
    test.setTimeout(90_000)
    const sessionId = await createLearnSession(nova)
    const delta = (field: 'reasoning_content' | 'content', text: string) => ({
      choices: [{ index: 0, delta: { [field]: text }, finish_reason: null }]
    })
    nova.provider.enqueue(
      { kind: 'tool', name: 'ls', arguments: { path: '.' }, callId: 'call_learn_stream' },
      {
        kind: 'raw',
        events: [
          { payload: delta('reasoning_content', '正在核对探索结果。') },
          { payload: delta('reasoning_content', '已经找到讲解入口。'), delayMs: 5_000 },
          { payload: delta('content', '正文首段。'), delayMs: 5_000 },
          { payload: delta('content', '\n\n正文后段。'), delayMs: 5_000 },
          { payload: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, delayMs: 5_000 }
        ]
      }
    )

    await sendLearningPrompt(nova, '探索当前目录后讲解入口')
    await nova.provider.waitForRequestCount(2)
    expect(JSON.stringify(nova.provider.requests[1]?.body)).toContain('e2e-marker.txt')
    const flow = learningFlow(nova)
    const cancel = nova.page.getByRole('button', { name: '中断生成' })

    // 每次断言都发生在下一类内容或终态到达之前。
    await expect(flow.getByText('正在核对探索结果。', { exact: false })).toBeVisible({ timeout: 3_000 })
    await expect(flow.getByText('已经找到讲解入口。', { exact: false })).toHaveCount(0)
    await expect(cancel).toBeVisible()
    await expect(flow.getByText('已经找到讲解入口。', { exact: false })).toBeVisible()
    await expect(flow.getByText('正文首段。', { exact: true })).toHaveCount(0)
    await expect(flow.getByText('正文首段。', { exact: true })).toBeVisible()
    await expect(flow.getByText('正文后段。', { exact: true })).toHaveCount(0)
    await expect(cancel).toBeVisible()
    await expect(flow.getByText('正文后段。', { exact: true })).toBeVisible()
    await expect(cancel).toBeVisible()

    await waitLearnTurnSettled(nova, sessionId)
    await expect(flow.getByText('正文首段。', { exact: true })).toHaveCount(1)
    await expect(flow.getByText('正文后段。', { exact: true })).toHaveCount(1)
    await expect(flow.getByText('正文首段。', { exact: true })).toBeVisible()
    await expect(flow.getByText('正文后段。', { exact: true })).toBeVisible()
    expect(nova.pageErrors).toEqual([])
  })

  test('进入学习不改动开发会话，空状态与大纲入口可辨', async ({ nova }) => {
    test.setTimeout(90_000)
    const devWorkspace = await nova.getWorkspace()
    const devSessionId = devWorkspace.currentSessionId
    expect(devSessionId).not.toBeNull()
    expect(devWorkspace.currentMode).toBe('default')

    const learnSessionId = await createLearnSession(nova)

    // 开发会话仍是 default，没有被原地改成 learn
    const sessions = (await nova.getWorkspace()).availableSessions
    const devSession = sessions.find(session => session.id === devSessionId)
    expect(devSession?.mode).toBe('default')
    expect(sessions.some(session => session.id === learnSessionId && session.mode === 'learn')).toBe(true)
    expect(await nova.invoke('load-sessions')).toEqual([])

    // 分段切换处于学习态；空状态给三条起点建议
    await expect(nova.page.getByRole('button', { name: '学习' }).first()).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    for (const label of ['画出项目全景与技术栈沙盘', '带我走一遍核心数据生命周期', '模拟答辩老师考考我']) {
      await expect(nova.page.getByRole('button', { name: label })).toBeVisible()
    }

    // 大纲在右侧面板：无大纲状态 + 直接生成入口 + 费用说明
    const pane = await openOutlinePane(nova)
    await expect(pane.getByText('还没有大纲')).toBeVisible()
    await expect(pane.getByRole('button', { name: '生成大纲' })).toBeVisible()
    await expect(pane.getByText('读取部分代码，调用 1–2 次模型')).toBeVisible()
  })

  test('出题停靠输入区，题目行锚定在产生它的回复之后', async ({ nova }) => {
    test.setTimeout(150_000)
    const sessionId = await createLearnSession(nova)

    nova.provider.enqueue(
      checkpointToolTurn('call_ckpt_e2e', 'CKPT_ANCHOR_TEXT\n\n```suggestions\n- 出题时不该出现的建议\n```')
    )
    await sendLearningPrompt(nova, '数据保存后刷新为什么还在？')
    await waitLearnTurnSettled(nova, sessionId)

    // 停靠面板替换输入区：同屏只有一个可编辑输入框；待答期间不出追问建议
    const dock = learningDock(nova)
    await expect(dock).toBeVisible()
    await expect(learningFlow(nova).getByRole('group', { name: '接下来可以问' })).toHaveCount(0)
    await expect(nova.page.getByText('出题时不该出现的建议', { exact: false })).toHaveCount(0)
    await expect(dock).toContainText(CHECKPOINT_QUESTION)
    for (const label of ['提示', '直接讲', '跳过']) {
      await expect(dock.getByRole('button', { name: label, exact: true })).toBeEnabled()
    }
    await expect(dock.getByRole('button', { name: '提交' })).toBeDisabled()
    await expect(nova.page.getByLabel('学习提问')).toHaveCount(0)
    await expect(nova.page.getByLabel('回答')).toBeVisible()
    await expectSingleLearningInput(nova)

    // 提示：用户气泡是一句短话，随后新回合正常完成
    nova.provider.enqueue({ kind: 'text', text: 'HINT_AFTER_ASK' })
    await dock.getByRole('button', { name: '提示', exact: true }).click()
    await expect(learningMain(nova).getByRole('article', { name: 'Message from user' }).last()).toHaveText('给点提示')
    await expect(nova.page.getByText('HINT_AFTER_ASK', { exact: false })).toBeVisible()
    await waitLearnTurnSettled(nova, sessionId)
    // 待答的题只在停靠面板里，不重复渲染成题目行
    await expect(dock).toContainText(CHECKPOINT_QUESTION)
    await expect(learningFlow(nova).getByRole('button', { name: CHECKPOINT_QUESTION })).toHaveCount(0)

    // 提交回答：停靠面板消失，恢复普通输入框；题目行出现并进入待评估
    nova.provider.enqueue({ kind: 'text', text: 'ASSESS_TURN_PENDING' })
    await fillLearningAnswer(nova, '应该是加载时重新查了数据库')
    await expect(dock.getByRole('button', { name: '提交' })).toBeEnabled()
    await dock.getByRole('button', { name: '提交' }).click()
    await expect(nova.page.getByText('ASSESS_TURN_PENDING', { exact: false })).toBeVisible()
    await waitLearnTurnSettled(nova, sessionId)

    await expect(nova.page.getByLabel('学习提问')).toBeVisible()
    await expect(dock).toHaveCount(0)
    await expectSingleLearningInput(nova)
    const flow = learningFlow(nova)
    const questionRow = flow.getByRole('button', { name: CHECKPOINT_QUESTION })
    await expect(questionRow).toBeVisible()
    await expect(flow.getByText('评估没完成')).toBeVisible()
    await expect(flow.getByRole('button', { name: '重试' })).toBeVisible()

    // 题目行出现在产生它的回复之后、后续回复之前，而不是对话末尾
    const anchorBox = await flow.getByText('CKPT_ANCHOR_TEXT', { exact: false }).first().boundingBox()
    const rowBox = await questionRow.boundingBox()
    const hintBox = await flow.getByText('HINT_AFTER_ASK', { exact: false }).first().boundingBox()
    expect(anchorBox).not.toBeNull()
    expect(rowBox).not.toBeNull()
    expect(hintBox).not.toBeNull()
    expect(rowBox!.y).toBeGreaterThan(anchorBox!.y)
    expect(rowBox!.y).toBeLessThan(hintBox!.y)

    // 所有用户气泡与侧栏标题都不含内部指令、内部概念或 id
    await expectNoInstructionLeak(nova)
    expect(nova.pageErrors).toEqual([])
  })

  test('回复末尾的推荐另起一行显示为建议，点击原样发送', async ({ nova }) => {
    test.setTimeout(120_000)
    const sessionId = await createLearnSession(nova)

    nova.provider.enqueue({
      kind: 'text',
      text: ['IPC 把请求从界面交给主进程。', '', '```suggestions', '- 主进程收到后怎么分发？', '- 画一下这条请求链路', '```'].join('\n')
    })
    await sendLearningPrompt(nova, '界面怎么调用主进程？')
    await waitLearnTurnSettled(nova, sessionId)

    const flow = learningFlow(nova)
    const suggestions = flow.getByRole('group', { name: '接下来可以问' })
    await expect(suggestions.getByRole('button')).toHaveText(['主进程收到后怎么分发？', '画一下这条请求链路'])
    // 推荐块不在正文里显示
    await expect(flow.getByText('- 主进程收到后怎么分发？', { exact: false })).toHaveCount(0)

    nova.provider.enqueue({ kind: 'text', text: 'SUGGESTION_FOLLOWUP' })
    await suggestions.getByRole('button', { name: '主进程收到后怎么分发？' }).click()
    await expect(learningMain(nova).getByRole('article', { name: 'Message from user' }).last()).toHaveText(
      '主进程收到后怎么分发？'
    )
    await expect(nova.page.getByText('SUGGESTION_FOLLOWUP', { exact: false })).toBeVisible()
    await waitLearnTurnSettled(nova, sessionId)

    // 建议只跟着最后一条回复；新回复没写推荐就不显示，不用固定文案顶替
    await expect(flow.getByRole('group', { name: '接下来可以问' })).toHaveCount(0)
    await expect(flow.getByRole('button', { name: '主进程收到后怎么分发？' })).toHaveCount(0)
    expect(nova.pageErrors).toEqual([])
  })

  test('生成中可取消，取消后可继续学习', async ({ nova }) => {
    test.setTimeout(120_000)
    const sessionId = await createLearnSession(nova)

    nova.provider.enqueue({ kind: 'hold', id: 'learning-hold', text: 'SHOULD_NOT_RENDER' })
    await sendLearningPrompt(nova, '先讲个不停的话题')

    const cancelButton = nova.page.getByRole('button', { name: '中断生成' })
    await expect(cancelButton).toBeVisible()
    const pending = learningMain(nova).getByRole('status').filter({ hasText: '正在思考' })
    await expect(pending).toHaveCount(1)
    await expect(pending).toBeVisible()
    await expect(pending).toContainText(/Nova|正在加班中|正在和Bug讲道理|正在摸清这个仓库|认真干活中/)
    await expect(learningMain(nova).getByText(/教练正在|导师正在|正在整理与核对/)).toHaveCount(0)
    await cancelButton.click()
    await nova.provider.waitForAbortCount(1, 15_000)
    await waitLearnTurnSettled(nova, sessionId)
    await expect(nova.page.getByText('SHOULD_NOT_RENDER', { exact: false })).toHaveCount(0)
    await expect(nova.page.getByRole('button', { name: '发送' })).toBeVisible()
    await expect(pending).toHaveCount(0)

    // 取消后仍可继续：新一轮正常完成
    nova.provider.enqueue({ kind: 'text', text: 'LEARN_AFTER_CANCEL' })
    await sendLearningPrompt(nova, '换个话题')
    await expect(nova.page.getByText('LEARN_AFTER_CANCEL', { exact: false })).toBeVisible()
    await waitLearnTurnSettled(nova, sessionId)
    expect(nova.pageErrors).toEqual([])
  })

  test('学习会话切换、reload 与重复 reload 后停点与消息可恢复', async ({ nova }) => {
    test.setTimeout(150_000)
    const firstSessionId = await createLearnSession(nova)

    nova.provider.enqueue(checkpointToolTurn('call_ckpt_reload'))
    await sendLearningPrompt(nova, '数据保存后刷新为什么还在？')
    await waitLearnTurnSettled(nova, firstSessionId)
    await expect(learningDock(nova)).toContainText(CHECKPOINT_QUESTION)

    // 新建第二个学习会话：第一个会话内容不串到第二个
    const secondSessionId = await createLearnSession(nova)
    expect(secondSessionId).not.toBe(firstSessionId)
    await expect(learningDock(nova)).toHaveCount(0)
    await expect(
      learningFlow(nova).getByText('数据保存后刷新为什么还在？', { exact: false })
    ).toHaveCount(0)

    // 切回第一个会话：停点与消息从持久化恢复
    await nova.selectSession(firstSessionId)
    await expect(learningDock(nova)).toContainText(CHECKPOINT_QUESTION)
    await expect(
      learningFlow(nova).getByText('数据保存后刷新为什么还在？', { exact: false })
    ).toBeVisible()

    // reload 与重复 reload：重新水合，监听器不叠加
    for (let index = 0; index < 2; index++) {
      await nova.page.reload()
      await expect(learningDock(nova)).toBeVisible()
      await expect(learningDock(nova)).toContainText(CHECKPOINT_QUESTION)
      await expect(
        learningFlow(nova).getByText('数据保存后刷新为什么还在？', { exact: false })
      ).toBeVisible()
      await expect(nova.page.getByLabel('回答')).toBeVisible()
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

    // 切回开发面：原开发会话恢复，草稿仍在
    await nova.page.getByRole('button', { name: '开发' }).first().click()
    await expect(nova.page.getByLabel('消息输入')).toBeVisible()
    expect(await readEditableValue(nova.page.getByLabel('消息输入'))).toContain('DEV_DRAFT_KEEP_ME')
    const backWorkspace = await nova.getWorkspace()
    expect(backWorkspace.currentSessionId).toBe(devSessionId)
    expect(backWorkspace.currentMode).toBe('default')

    // 确实改过代码的开发回复才有「学懂这次改动」入口
    nova.provider.enqueue(
      {
        kind: 'tool',
        name: 'write',
        arguments: { path: 'change-log.md', content: '# 改动说明\n' },
        callId: 'call_write_e2e'
      },
      { kind: 'text', text: 'DEV_CHANGE_SUMMARY_TEXT' }
    )
    await nova.sendPrompt('改一下保存入口')
    await expect(nova.page.getByText('DEV_CHANGE_SUMMARY_TEXT', { exact: false })).toBeVisible()
    await nova.waitUntilIdle()

    const assistantMessage = nova.page.getByRole('article', { name: 'Message from assistant' }).last()
    await assistantMessage.hover()
    const learnEntry = assistantMessage.getByRole('button', { name: '学懂这次改动' })
    await expect(learnEntry).toBeVisible()

    // 教练回合在点击时即发起：响应必须先入队
    nova.provider.enqueue({ kind: 'text', text: 'DEV_LINK_COACH_REPLY' })
    await learnEntry.click()

    // 进入学习表面并自动发起讲解回合
    await expect(nova.page.getByLabel('学习提问')).toBeVisible()
    const switchedWorkspace = await nova.getWorkspace()
    expect(switchedWorkspace.currentSessionId).toBe(learnSessionId)
    await expect(nova.page.getByText('DEV_LINK_COACH_REPLY', { exact: false })).toBeVisible()
    await waitLearnTurnSettled(nova, learnSessionId)

    // 用户气泡是一句短话：不带指令、摘录或会话 id
    const lastBubble = learningMain(nova).getByRole('article', { name: 'Message from user' }).last()
    await expect(lastBubble).toContainText('这次改动')
    await expect(lastBubble).not.toContainText(devSessionId)
    await expectNoInstructionLeak(nova)
    expect(nova.pageErrors).toEqual([])
  })

  test('生成中提交回答被拒，原状态与草稿保留', async ({ nova }) => {
    test.setTimeout(150_000)
    const sessionId = await createLearnSession(nova)

    nova.provider.enqueue(checkpointToolTurn('call_ckpt_busy'))
    await sendLearningPrompt(nova, '数据保存后刷新为什么还在？')
    await waitLearnTurnSettled(nova, sessionId)

    const dock = learningDock(nova)
    await expect(dock).toContainText(CHECKPOINT_QUESTION)
    await fillLearningAnswer(nova, '生成中尝试提交的回答')

    // 提示会启动一次新回合；让该回合 hold 住，制造生成中窗口
    nova.provider.enqueue({ kind: 'hold', id: 'learning-busy-hold', text: 'HOLDING_HINT' })
    await dock.getByRole('button', { name: '提示', exact: true }).click()
    await expect(nova.page.getByRole('button', { name: '中断生成' })).toBeVisible()

    // UI 在生成中禁用提交；绕过 UI 直接提交结构化回答，验证服务端接纳层拒绝
    const receipt = await nova.page.evaluate(async (sid: string) => {
      const api = (window as typeof window & { api?: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } }).api
      const surface = (await api!.invoke('learning:get-surface', { sessionId: sid })) as {
        clearGeneration: number
        cursorVersion: number
        currentCheckpointId: string | null
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
            checkpointId: surface.currentCheckpointId,
            text: '生成中尝试提交的回答',
            optionIds: []
          }
        }
      }) as Promise<{ ok: boolean; code: string }>
    }, sessionId)
    expect(receipt.ok).toBe(false)
    expect(receipt.code).toBe('busy')

    // 停点未被消费：面板仍在等回答，草稿原样保留
    await expect(dock).toContainText(CHECKPOINT_QUESTION)
    expect(await readEditableValue(nova.page.getByLabel('回答'))).toContain('生成中尝试提交的回答')

    // 取消挂住的回合后，同一回答可以从界面正常提交
    await nova.page.getByRole('button', { name: '中断生成' }).click()
    await nova.provider.waitForAbortCount(1, 15_000)
    await waitLearnTurnSettled(nova, sessionId)
    nova.provider.enqueue({ kind: 'text', text: 'BUSY_RETRY_ASSESS_DONE' })
    await dock.getByRole('button', { name: '提交' }).click()
    await expect(nova.page.getByText('BUSY_RETRY_ASSESS_DONE', { exact: false })).toBeVisible()
    await waitLearnTurnSettled(nova, sessionId)

    // 回答已保存待评估：输入区恢复，重试评估入口出现在题目行上
    await expect(nova.page.getByLabel('学习提问')).toBeVisible()
    const flow = learningFlow(nova)
    await expect(flow.getByText('评估没完成')).toBeVisible()
    await expect(flow.getByRole('button', { name: '重试' })).toBeVisible()
    expect(nova.pageErrors).toEqual([])
  })

  test('大纲生成：失败可重试，生成中可取消，成功后进详情并开始学习', async ({ nova }) => {
    test.setTimeout(240_000)
    const sessionId = await createLearnSession(nova)
    await writeSampleCode(nova.workspacePath)
    const pane = await openOutlinePane(nova)

    // 失败：模型请求全部 500 → 错误横幅 + 重试
    installOutlineBuildFailure(nova.provider)
    await pane.getByRole('button', { name: '生成大纲' }).click()
    await expect(pane.getByText(/模型请求失败/)).toBeVisible({ timeout: 60_000 })
    const retryButton = pane.getByRole('button', { name: '重试' })
    await expect(retryButton).toBeVisible()

    // 生成中：构建请求挂起，显示三步指示，取消后回到无大纲
    installOutlineBuildHold(nova.provider, 'build-hold')
    await retryButton.click()
    await expect(pane.getByText('整理大纲')).toBeVisible({ timeout: 30_000 })
    await pane.getByRole('button', { name: '取消' }).click()
    await nova.provider.waitForAbortCount(1, 15_000)
    await expect(pane.getByText('还没有大纲')).toBeVisible({ timeout: 30_000 })

    // 成功：按取证请求返回合法编译输出 → 分组列表出现
    const buildInfo: OutlineBuildInfo = { sourceId: null, sourcePath: null }
    installOutlineBuildSuccess(nova.provider, buildInfo)
    await pane.getByRole('button', { name: '生成大纲' }).click()
    await expect(outlineTopicRow(pane, '应用如何启动')).toBeVisible({ timeout: 60_000 })
    await expect(pane.getByRole('heading', { name: '模块职责' })).toBeVisible()
    // 部分推断的主题带 ≈ 标记
    await expect(pane.getByLabel('部分内容是推断').first()).toBeVisible()
    // 右上 ⋯ 菜单只有重新生成
    await pane.getByRole('button', { name: '大纲操作' }).click()
    await expect(nova.page.getByRole('menuitem', { name: '重新生成大纲' })).toBeVisible()
    // Escape 会被 Inspector 的全局监听吃掉并连带关掉面板，这里点标题收起菜单
    await pane.getByRole('heading', { name: '模块职责' }).click()
    await expect(nova.page.getByRole('menuitem', { name: '重新生成大纲' })).toHaveCount(0)

    // 详情：返回、目标、要点与出处片段
    await outlineTopicRow(pane, '应用如何启动').click()
    await expect(pane.getByRole('button', { name: '返回大纲' })).toBeVisible()
    await expect(pane.getByText('说清启动顺序')).toBeVisible()
    await expect(pane.getByText('启动入口负责装配核心模块')).toBeVisible()
    if (buildInfo.sourcePath) {
      const fileName = buildInfo.sourcePath.split(/[\\/]/).pop() ?? buildInfo.sourcePath
      const chip = pane.getByRole('button', { name: new RegExp(`^${fileName.replace(/\./g, '\\.')}:\\d+$`) })
      await expect(chip).toBeVisible()
      await chip.click()
      await expect(pane.getByRole('region', { name: '代码片段' })).toBeVisible()
      await expect(pane.getByRole('region', { name: '代码片段' })).not.toBeEmpty()
    }
    // 详情 ⋯ 菜单提供开发侧入口
    await pane.getByRole('button', { name: '主题操作' }).click()
    await expect(nova.page.getByRole('menuitem', { name: '在开发会话中修改' })).toBeVisible()
    await pane.getByRole('heading', { name: '应用如何启动' }).click()
    await expect(nova.page.getByRole('menuitem', { name: '在开发会话中修改' })).toHaveCount(0)

    // 从这里开始学：分隔线 + 教练回合，用户气泡是短话
    nova.provider.enqueue({ kind: 'text', text: 'COACH_START_REPLY' })
    await pane.getByRole('button', { name: '从这里开始学' }).click()
    await expect(learningFlow(nova).getByText('开始学习「应用如何启动」')).toBeVisible({ timeout: 30_000 })
    await expect(nova.page.getByText('COACH_START_REPLY', { exact: false })).toBeVisible()
    await waitLearnTurnSettled(nova, sessionId)
    await expectNoInstructionLeak(nova)
    expect(nova.pageErrors).toEqual([])
  })

  for (const state of ['queued', 'paused'] as const) {
    test(`大纲${state === 'queued' ? '排队' : '暂停'}后在前台执行清理完成时自动继续`, async ({ nova }) => {
      test.setTimeout(120_000)
      const sessionId = await createLearnSession(nova)
      await writeSampleCode(nova.workspacePath)
      const pane = await openOutlinePane(nova)
      if (state === 'paused') {
        installOutlineBuildHold(nova.provider, 'build-before-foreground')
        await pane.getByRole('button', { name: '生成大纲' }).click()
        await expect(pane.getByText('整理大纲')).toBeVisible({ timeout: 30_000 })
        await nova.provider.waitForRequestCount(1, 15_000)
      }

      const beforeForeground = nova.provider.requests.length
      nova.provider.enqueue({ kind: 'hold', id: 'foreground', text: 'FOREGROUND_FINISHED' })
      await sendLearningPrompt(nova, '先讲一下项目用途')
      await nova.provider.waitForRequestCount(beforeForeground + 1, 15_000)
      await expect(nova.page.getByRole('button', { name: '中断生成' })).toBeVisible()
      const info: OutlineBuildInfo = { sourceId: null, sourcePath: null }
      installOutlineBuildSuccess(nova.provider, info)
      if (state === 'queued') {
        await pane.getByRole('button', { name: '生成大纲' }).click()
        await expect(pane.getByText('等当前任务结束后开始')).toBeVisible()
      } else {
        await expect(pane.getByText('已暂停，当前任务结束后继续')).toBeVisible()
        await nova.provider.waitForAbortCount(1, 15_000)
      }

      nova.provider.release('foreground')
      await waitLearnTurnSettled(nova, sessionId)
      await expect(outlineTopicRow(pane, '应用如何启动')).toBeVisible({ timeout: 60_000 })
      expect(nova.pageErrors).toEqual([])
    })
  }

  test('学习可视化在内联与展开视图保持可读尺寸', async ({ nova }, testInfo) => {
    test.setTimeout(120_000)
    await nova.page.setViewportSize({ width: 1280, height: 860 })
    const sessionId = await createLearnSession(nova)
    const draft = `## 请求处理状态

\`\`\`callout tone=success title=已完成
主进程已经确认写入，界面可以展示最终结果。
\`\`\`

\`\`\`flow selected=Main
Renderer -> Main: 类型化调用
Main -> SessionStore: 校验并写入
\`\`\`

\`\`\`ask id=readability-followup
需要继续看写入细节吗？
深入讲讲 | 深入讲讲请求处理
\`\`\``
    nova.provider.enqueue(
      {
        kind: 'tool',
        name: 'present_visualization',
        arguments: { title: '学习状态与操作', draft },
        callId: 'call_readability_viz'
      },
      { kind: 'text', text: 'READABILITY_VIZ_SHOWN' }
    )
    await sendLearningPrompt(nova, '画出请求处理状态')
    await expect(nova.page.getByText('READABILITY_VIZ_SHOWN', { exact: false })).toBeVisible()
    await waitLearnTurnSettled(nova, sessionId)

    const card = nova.page.getByTestId('visualization-card')
    await expect(card).toHaveAttribute('data-state', 'ok')
    const inlineFrame = await contentFrameOf(await settledFrame(card))
    await expect(inlineFrame.getByText('主进程已经确认写入，界面可以展示最终结果。')).toBeVisible()

    const screenshotDir = path.resolve(__dirname, '../../../test-results/e2e/learning-readability')
    await mkdir(screenshotDir, { recursive: true })
    const capture = async (name: string): Promise<void> => {
      const file = path.join(screenshotDir, `${name}.png`)
      await nova.page.screenshot({ path: file, animations: 'disabled' })
      await testInfo.attach(`${name}.png`, { path: file, contentType: 'image/png' })
    }
    const expectReadable = async (frame: Frame): Promise<void> => {
      const metrics = await frame.evaluate(() => {
        const fontSize = (selector: string): number => {
          const element = document.querySelector(selector)
          if (!element) throw new Error(`缺少可读性测量元素 ${selector}`)
          return Number.parseFloat(getComputedStyle(element).fontSize)
        }
        const button = document.querySelector('.viz-btn')!.getBoundingClientRect()
        return {
          body: Number.parseFloat(getComputedStyle(document.body).fontSize),
          note: fontSize('.viz-draft-callout'),
          auxiliary: fontSize('.viz-draft-flow__edges'),
          buttonFont: fontSize('.viz-btn'),
          buttonHeight: button.height
        }
      })
      expect(metrics.body).toBeGreaterThanOrEqual(14)
      expect(metrics.note).toBeGreaterThanOrEqual(14)
      expect(metrics.auxiliary).toBeGreaterThanOrEqual(12)
      expect(metrics.buttonFont).toBeGreaterThanOrEqual(14)
      expect(metrics.buttonHeight).toBeGreaterThanOrEqual(36)
    }

    await capture('inline-before')
    await expectReadable(inlineFrame)
    await inlineFrame.locator('[data-viz-select="SessionStore"]').click()
    await expect(inlineFrame.locator('[data-viz-select="SessionStore"]')).toHaveAttribute('data-active', 'true')

    await card.getByRole('button', { name: '展开' }).click()
    const dialog = nova.page.getByRole('dialog', { name: '学习状态与操作' })
    await expect(dialog).toBeVisible()
    const modalFrame = await contentFrameOf(dialog.getByTestId('visualization-frame'))
    await expect(modalFrame.locator('.viz-draft-panel__title')).toHaveText('请求处理状态')
    await expectReadable(modalFrame)
    await capture('expanded-after')
    expect(nova.pageErrors).toEqual([])
  })

  test('学习会话里的可视化点击进入学习对话，答题期间只提示不发送', async ({ nova }) => {
    test.setTimeout(150_000)
    const sessionId = await createLearnSession(nova)

    nova.provider.enqueue(
      {
        kind: 'tool',
        name: 'present_visualization',
        arguments: { title: '学习架构图', draft: LEARN_VIZ_DRAFT },
        callId: 'call_learn_viz'
      },
      { kind: 'text', text: 'LEARN_VIZ_SHOWN' }
    )
    await sendLearningPrompt(nova, '画一张架构图')
    await expect(nova.page.getByText('LEARN_VIZ_SHOWN', { exact: false })).toBeVisible()
    await waitLearnTurnSettled(nova, sessionId)

    const card = nova.page.getByTestId('visualization-card')
    await expect(card).toHaveAttribute('data-state', 'ok')
    const frame = await contentFrameOf(await settledFrame(card))

    await nova.page.waitForTimeout(1_100)
    nova.provider.enqueue({ kind: 'text', text: 'LEARN_VIZ_EVENT_ACK' })
    await frame.locator('[data-viz-ask]').click()

    await expect(learningMain(nova).getByRole('article', { name: 'Message from user' }).last()).toContainText(
      '深入讲讲：深入讲讲 E2E 模块'
    )
    await expect(nova.page.getByText('LEARN_VIZ_EVENT_ACK', { exact: false })).toBeVisible()
    await waitLearnTurnSettled(nova, sessionId)

    const ckptTurn = JSON.parse(
      JSON.stringify(checkpointToolTurn('call_ckpt_after_viz')).replace(
        '\\"cursorVersion\\":1',
        '\\"cursorVersion\\":3'
      )
    ) as ReturnType<typeof checkpointToolTurn>
    nova.provider.enqueue(ckptTurn)
    await sendLearningPrompt(nova, '考考我')
    await waitLearnTurnSettled(nova, sessionId)
    const dock = learningDock(nova)
    await expect(dock).toBeVisible()
    await fillLearningAnswer(nova, 'KEEP_MY_ANSWER_DRAFT')

    const requestCountBefore = nova.provider.requests.length
    await nova.page.waitForTimeout(1_100)
    await frame.locator('[data-viz-ask]').click()

    await expect(card.locator('.visualization-card__notice')).toContainText('先回答当前问题')
    expect(nova.provider.requests).toHaveLength(requestCountBefore)
    expect(await readEditableValue(nova.page.getByLabel('回答'))).toContain('KEEP_MY_ANSWER_DRAFT')

    await expectNoInstructionLeak(nova)
    expect(nova.pageErrors).toEqual([])
  })

  test('学习会话里调过的组件值随下一条学习消息回传一次，用户气泡里不显示', async ({ nova }) => {
    const sessionId = await createLearnSession(nova)
    const fence = [
      '```openui',
      'root = Col([Slider($n, "副本数", 1, 5, 1), Stat("可容忍故障", $n - 1 + " 台")])',
      '$n = 3',
      '```'
    ].join('\n')
    nova.provider.enqueue({ kind: 'text', text: `调一调副本数：\n\n${fence}\n\nLEARN_OPENUI_SHOWN` })
    await sendLearningPrompt(nova, '副本数和容错是什么关系')
    await expect(nova.page.getByText('LEARN_OPENUI_SHOWN', { exact: false })).toBeVisible()
    await waitLearnTurnSettled(nova, sessionId)

    const slider = learningMain(nova).locator('[role="slider"]')
    await expect(slider).toBeEnabled()
    await slider.focus()
    await nova.page.keyboard.press('End')
    await expect(slider).toHaveAttribute('aria-valuenow', '5')
    await expect(learningMain(nova).locator('.inline-ui__stat-value')).toHaveText('4 台')

    // 学习消息走独立的学习命令通道：组件状态按学习会话认领，随这条提问交给模型
    const sentWith = async (prompt: string): Promise<Record<string, unknown>> => {
      const offset = nova.provider.requests.length
      await sendLearningPrompt(nova, prompt)
      await expect
        .poll(() => nova.provider.requests.slice(offset).some(request => userTexts(request.body).at(-1)?.includes(prompt)))
        .toBe(true)
      const request = nova.provider.requests.slice(offset).find(item => userTexts(item.body).at(-1)?.includes(prompt))
      if (!request) throw new Error(`没有找到携带「${prompt}」的模型请求`)
      return request.body
    }
    nova.provider.enqueue({ kind: 'text', text: 'LEARN_OPENUI_ACK' })
    const withState = userTexts(await sentWith('调到 5 之后呢')).at(-1) ?? ''
    expect(withState).toContain('[界面状态]')
    expect(withState).toContain('「交互组件」：副本数 = 5')
    await expect(nova.page.getByText('LEARN_OPENUI_ACK', { exact: false })).toBeVisible()
    await waitLearnTurnSettled(nova, sessionId)
    const lastBubble = learningMain(nova).getByRole('article', { name: 'Message from user' }).last()
    await expect(lastBubble).toContainText('调到 5 之后呢')
    await expect(lastBubble).not.toContainText('界面状态')

    nova.provider.enqueue({ kind: 'text', text: 'LEARN_OPENUI_NEXT' })
    const nextBody = await sentWith('再讲讲为什么')
    expect(userTexts(nextBody).at(-1)).not.toContain('[界面状态]')
    expect(userTexts(nextBody).filter(content => content.includes('[界面状态]'))).toHaveLength(1)
    await expect(nova.page.getByText('LEARN_OPENUI_NEXT', { exact: false })).toBeVisible()
    await waitLearnTurnSettled(nova, sessionId)

    await expectNoInstructionLeak(nova)
    expect(nova.pageErrors).toEqual([])
  })

  test('学习内联图使用确定性几何布局并保留模块交互', async ({ nova }, testInfo) => {
    test.setTimeout(120_000)
    await nova.page.setViewportSize({ width: 1440, height: 1000 })
    await nova.invoke('settings:set', { theme: 'dark' })
    await nova.page.reload()
    const sessionId = await createLearnSession(nova)
    const code = [
      'root = Col([shortFlow, longFlow, architecture])',
      'shortFlow = Flow([{title: "CLI", detail: "接收提问"}, {title: "请求模型", detail: "装配上下文"}, {title: "回灌并继续", detail: "写回工具结果"}, {title: "渲染回答", detail: "显示最终内容"}], $short)',
      'longFlow = Flow(longSteps, $long)',
      'architecture = Architecture(layers, $module)',
      '$short = 0',
      '$long = 0',
      '$module = 0',
      'longSteps = [',
      '  {title: "CLI 收下提问", detail: "接收原始输入"},',
      '  {title: "拼系统提示", detail: "装配系统提示"},',
      '  {title: "请求模型", detail: "发起模型请求"},',
      '  {title: "抠出工具调用", detail: "解析工具调用"},',
      '  {title: "过闸再执行", detail: "检查后执行"},',
      '  {title: "回灌再问一轮", detail: "写回结果并继续"}',
      ']',
      'layers = [entry, orchestration, capability, support]',
      'entry = {title: "入口层", relation: "调用 / 委托", nodes: [cli, index]}',
      'cli = {title: "cli.ts", detail: "接收命令行输入"}',
      'index = {title: "index.ts", detail: "组装应用入口"}',
      'orchestration = {title: "编排层", relation: "注册 / 取用", nodes: [agent, orchestrator]}',
      'agent = {title: "agent.ts", detail: "驱动模型与工具循环"}',
      'orchestrator = {title: "orchestrator.ts", detail: "负责拆分任务并协调子代理", meta: "编排层 · 核心协调", file: "src/orchestrator.ts:42", ask: "ARCH_ASK_PROMPT 编排器如何处理失败？"}',
      'capability = {title: "能力层", relation: "读取配置 / 打日志 / 落盘", nodes: [registry, tools, skills]}',
      'registry = {title: "tools/registry.ts", detail: "登记工具"}',
      'tools = {title: "tools / 内置 22 个", detail: "提供内置能力"}',
      'skills = {title: "skills.ts", detail: "装载技能"}',
      'support = {title: "支撑层", nodes: [config, logger, jsonUtils, memory]}',
      'config = {title: "config.ts", detail: "读取配置"}',
      'logger = {title: "logger.ts", detail: "记录日志"}',
      'jsonUtils = {title: "utils/json_utils.ts", detail: "处理 JSON"}',
      'memory = {title: "memory.ts", detail: "保存记忆"}'
    ].join('\n')
    const fence = ['```openui', code, '```'].join('\n')
    nova.provider.enqueue({ kind: 'text', text: `显示固定学习图：\n\n${fence}\n\nDETERMINISTIC_VISUALS_DONE` })
    await sendLearningPrompt(nova, '检查学习图布局')
    await expect(nova.page.getByText('DETERMINISTIC_VISUALS_DONE', { exact: false })).toBeVisible()
    await waitLearnTurnSettled(nova, sessionId)

    const inline = learningMain(nova).locator('.inline-ui')
    const shortFlow = inline.locator('.inline-ui__flow').nth(0)
    const longFlow = inline.locator('.inline-ui__flow').nth(1)
    const architecture = inline.locator('.inline-ui__architecture')
    const expectEqualNodeWidths = async (scope: Locator, selector: string): Promise<void> => {
      const widths = await scope.locator(selector).evaluateAll(elements =>
        elements.map(element => element.getBoundingClientRect().width)
      )
      expect(widths.length).toBeGreaterThan(0)
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1)
    }

    await expect(shortFlow).toHaveClass(/inline-ui__flow--row/)
    await expectEqualNodeWidths(shortFlow, '.inline-ui__flow-node')
    await expect(longFlow).toHaveClass(/inline-ui__flow--col/)
    await expectEqualNodeWidths(longFlow, '.inline-ui__flow-node')
    const longBox = await longFlow.boundingBox()
    if (!longBox) throw new Error('长流程尚未完成布局')
    const longCenters = await longFlow.locator('.inline-ui__flow-node').evaluateAll(elements =>
      elements.map(element => {
        const rect = element.getBoundingClientRect()
        return rect.left + rect.width / 2
      })
    )
    for (const center of longCenters) {
      expect(Math.abs(center - (longBox.x + longBox.width / 2))).toBeLessThanOrEqual(1)
    }

    await expect(architecture).toHaveCount(1)
    await expect(architecture.locator('.inline-ui__architecture-node')).toHaveCount(11)
    await expectEqualNodeWidths(architecture, '.inline-ui__architecture-node')
    const centerDeltas = await architecture.locator('.inline-ui__architecture-layer').evaluateAll(layers =>
      layers.flatMap(layer => {
        const area = layer.querySelector('.inline-ui__architecture-nodes')
        if (!area) return []
        const areaRect = area.getBoundingClientRect()
        const rows = new Map<number, { left: number; right: number }>()
        for (const node of area.querySelectorAll('.inline-ui__architecture-node')) {
          const rect = node.getBoundingClientRect()
          const key = Math.round(rect.top)
          const row = rows.get(key) ?? { left: rect.left, right: rect.right }
          row.left = Math.min(row.left, rect.left)
          row.right = Math.max(row.right, rect.right)
          rows.set(key, row)
        }
        return [...rows.values()].map(row => Math.abs((row.left + row.right - areaRect.left - areaRect.right) / 2))
      })
    )
    for (const delta of centerDeltas) expect(delta).toBeLessThanOrEqual(1)

    await expect(architecture.locator('.inline-ui__walk-detail-title')).toHaveText('cli.ts')
    await architecture.getByRole('button', { name: 'orchestrator.ts', exact: true }).click()
    await expect(architecture.locator('.inline-ui__walk-detail-title')).toHaveText('orchestrator.ts')
    await expect(architecture.locator('.inline-ui__walk-detail-text')).toContainText('协调子代理')

    const screenshotDir = path.resolve(__dirname, '../../../test-results/e2e/deterministic-learning-visuals')
    await mkdir(screenshotDir, { recursive: true })
    for (const [name, locator] of [['architecture', architecture], ['flow', longFlow]] as const) {
      const file = path.join(screenshotDir, `${name}.png`)
      await locator.screenshot({ path: file, animations: 'disabled' })
      await testInfo.attach(`${name}.png`, { path: file, contentType: 'image/png' })
    }

    const offset = nova.provider.requests.length
    nova.provider.enqueue({ kind: 'text', text: 'ARCH_ASK_DONE' })
    await architecture.getByRole('button', { name: '深入讲讲这个模块' }).click()
    await expect
      .poll(() => nova.provider.requests.slice(offset).some(request => userTexts(request.body).at(-1)?.includes('ARCH_ASK_PROMPT')))
      .toBe(true)
    await expect(nova.page.getByText('ARCH_ASK_DONE', { exact: false })).toBeVisible()
    await waitLearnTurnSettled(nova, sessionId)

    await inline.evaluate(element => { (element as HTMLElement).style.width = '380px' })
    await expect(shortFlow).toHaveClass(/inline-ui__flow--col/)
    await expectEqualNodeWidths(architecture, '.inline-ui__architecture-node')
    expect(await inline.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    const detailBox = await longFlow.locator('.inline-ui__flow-inspector-body').boundingBox()
    const transportBox = await longFlow.locator('.inline-ui__flow-transport').boundingBox()
    if (!detailBox || !transportBox) throw new Error('紧凑流程详情尚未完成布局')
    expect(transportBox.y).toBeGreaterThanOrEqual(detailBox.y + detailBox.height - 1)
    await inline.evaluate(element => { (element as HTMLElement).style.removeProperty('width') })
    expect(nova.pageErrors).toEqual([])
  })

  test('分阶段讲解随正文流式逐步长出，回答完成后可跨阶段翻页并追问', async ({ nova }) => {
    const sessionId = await createLearnSession(nova)
    const lines = [
      'root = Walkthrough([prep, loop], $step)',
      '$step = 0',
      'prep = {title: "装配", summary: "把问题拼成消息", io: "query → messages", steps: [s1, s2]}',
      's1 = {title: "初始化消息", meta: "Agent · agent.ts:54", detail: "系统指令放第一条，用户问题放第二条", data: {messages: "Array(2)"}, code: "const messages = []", file: "src/agent.ts:54"}',
      's2 = {title: "附工具", detail: "带上工具清单"}',
      'loop = {title: "往返", summary: "模型决定回答还是调用工具", steps: [s3]}',
      's3 = {title: "请求模型", detail: "把消息发给模型", ask: "WALK_ASK_PROMPT 返回 tool_calls 怎么继续？"}'
    ]
    const chunks = ['讲一遍生命周期：\n\n```openui\n', ...lines.map(line => `${line}\n`), '```\n\nLEARN_WALK_DONE']
    nova.provider.enqueue({ kind: 'text', text: chunks.join(''), chunks, chunkDelayMs: 400 })
    await sendLearningPrompt(nova, '一次提问的数据生命周期')

    // 流式中：先只有第一阶段，详情跟随刚写完的一步；之后第二阶段出现
    const walk = learningMain(nova).locator('.inline-ui__walk')
    await expect(walk.locator('.inline-ui__walk-phase')).toHaveCount(1)
    await expect(walk.locator('.inline-ui__walk-detail-title')).toHaveText('附工具')
    await expect(walk.locator('.inline-ui__walk-phase')).toHaveCount(2)
    await expect(nova.page.getByText('LEARN_WALK_DONE', { exact: false })).toBeVisible()
    await waitLearnTurnSettled(nova, sessionId)

    await expect(walk.locator('.inline-ui__walk-position')).toHaveText('第 1 / 3 步')
    await walk.getByRole('button', { name: 'src/agent.ts:54' }).click()
    await expect(walk.locator('.inline-ui__walk-source pre')).toContainText('const messages = []')
    await walk.getByRole('button', { name: '下一步' }).click()
    await walk.getByRole('button', { name: '下一阶段' }).click()
    await expect(walk.locator('.inline-ui__walk-kicker')).toHaveText('阶段 2 / 2')

    const offset = nova.provider.requests.length
    nova.provider.enqueue({ kind: 'text', text: 'LEARN_WALK_ASKED' })
    await walk.getByRole('button', { name: '深入讲讲这一步' }).click()
    await expect
      .poll(() => nova.provider.requests.slice(offset).some(request => userTexts(request.body).at(-1)?.includes('WALK_ASK_PROMPT')))
      .toBe(true)
    await expect(nova.page.getByText('LEARN_WALK_ASKED', { exact: false })).toBeVisible()

    expect(nova.pageErrors).toEqual([])
  })

  test('学习输入框对齐开发体验：发送即刻清空草稿并上屏用户气泡、支持 MiniMax-M3.1-Flash 思考强度与 16 步阶段泳道沙盘', async ({
    nova
  }, testInfo) => {
    test.setTimeout(180_000)
    await nova.page.setViewportSize({ width: 1280, height: 860 })
    const screenshotDir = path.resolve(__dirname, '../../../test-results/e2e/intelligent-ui')
    await mkdir(screenshotDir, { recursive: true })

    // 切换模型为 MiniMax-M3.1-Flash，验证学习模式下思考强度控件与上下文用量指示器正常显示
    await nova.invoke('save-llm-registry', {
      version: 2,
      providers: [
        {
          id: 'effort-provider',
          name: 'MiniMax',
          baseUrl: nova.provider.baseUrl,
          apiKey: 'nova-e2e-key',
          enabled: true,
          models: [{ id: 'minimax-m27', modelId: 'MiniMax-M3.1-Flash', displayName: 'MiniMax-M3.1-Flash' }]
        }
      ],
      activeModel: { providerId: 'effort-provider', modelEntryId: 'minimax-m27' }
    })
    await nova.page.reload()
    const sessionId = await createLearnSession(nova)

    const main = learningMain(nova)
    await expect(main.getByRole('button', { name: '思考强度：Max' })).toBeVisible()
    await expect(main.getByRole('button', { name: /上下文容量/ })).toBeVisible()
    await expect(main.getByRole('button', { name: /工作区：/ })).toBeVisible()

    // 无效草稿先在编译入口失败，模型收到草稿行号后再发布完整流程
    const crammed16Draft = '## 拥挤的16步胶囊条\n\n```flow\n没有合法边\n```'
    const phased16WorkbenchDraft = `## miniagent-ts 数据流转：从一句话到最终答案


4 个阶段、16 个关键节点；选择节点只在图内更新，不发新回合。

\`\`\`flow selected=入口命令
@group 输入与接纳
入口命令
命令路由
消息入栈
回合锁获取
@group 装配与推理
系统提示词装配
历史窗口裁剪
发起流式请求
增量块解码
@group 工具与沙箱
工具参数校验
权限与副作用门禁
沙箱执行工具
工具结果写回
@group 落盘与呈现
生成最终回答
消息事务落盘
释放回合锁
最终输出呈现
入口命令 -> 命令路由: 分发
命令路由 -> 消息入栈: 用户消息
消息入栈 -> 回合锁获取: 启动回合
回合锁获取 -> 系统提示词装配: 上下文
系统提示词装配 -> 历史窗口裁剪: 预算
历史窗口裁剪 -> 发起流式请求: messages
发起流式请求 -> 增量块解码: SSE
增量块解码 -> 工具参数校验: tool_call
工具参数校验 -> 权限与副作用门禁: 校验结果
权限与副作用门禁 -> 沙箱执行工具: 授权
沙箱执行工具 -> 工具结果写回: ToolResult
工具结果写回 -> 生成最终回答: 下一轮
生成最终回答 -> 消息事务落盘: 完整回复
消息事务落盘 -> 释放回合锁: 已提交
释放回合锁 -> 最终输出呈现: completed
\`\`\`

\`\`\`ask id=deep-dive-step
想深入看当前关键步骤吗？
深入讲讲这一步 | 请结合源码深入讲讲沙箱执行工具的异常边界
\`\`\`

`

    // 先挂起首个流式回合，验证用户提问发送后：输入框立即清空、用户消息气泡立即出现（不等回合结束）
    nova.provider.enqueue(
      { kind: 'hold', id: 'hold-user-bubble-check', text: '正在梳理 16 步完整数据流转…' }
    )
    const userQuestion = '用户随便问了一个问题，经历了怎样的流程才看到最终答案？'
    await sendLearningPrompt(nova, userQuestion)

    // 断言 1：输入框草稿已立即清空，不再卡在输入框中
    await expect.poll(() => readEditableValue(nova.page.getByLabel('学习提问'))).toBe('')
    // 断言 2：在回合仍在生成中（中断生成按钮可见）时，用户气泡已经渲染在对话流中
    await expect(nova.page.getByRole('button', { name: '中断生成' })).toBeVisible()
    await expect(learningMain(nova).getByRole('article', { name: 'Message from user' }).last()).toContainText(
      userQuestion
    )

    nova.provider.release('hold-user-bubble-check')
    await waitLearnTurnSettled(nova, sessionId)

    // 第二轮：无效 flow 被草稿诊断打回，再发布分阶段的 16 节点流程
    nova.provider.enqueue(
      {
        kind: 'tool',
        name: 'present_visualization',
        arguments: { title: '拥挤的16步胶囊条', draft: crammed16Draft },
        callId: 'call_crammed_16'
      },
      {
        kind: 'tool',
        name: 'present_visualization',
        arguments: { title: 'miniagent-ts 数据流转：从一句话到最终答案', draft: phased16WorkbenchDraft },
        callId: 'call_phased_16'
      },
      { kind: 'text', text: '上面是按 4 个阶段拆解的 16 步完整数据流转沙盘，点击节点可查看当前选择。' }
    )

    await sendLearningPrompt(nova, '把这个 16 步流程画成可交互的数据流转图')
    await expect(
      nova.page.getByText('上面是按 4 个阶段拆解的 16 步完整数据流转沙盘', { exact: false })
    ).toBeVisible({ timeout: 30_000 })
    await waitLearnTurnSettled(nova, sessionId)

    // 只有合规的分阶段工作台被发布渲染（拥挤版被拦截，工具返回了修正提示）
    const cards = nova.page.getByTestId('visualization-card')
    await expect(cards).toHaveCount(1)
    const card = cards.first()
    await expect(card).toHaveAttribute('data-state', 'ok')

    const inlineFrameEl = await settledFrame(card)
    const inlineFrame = await contentFrameOf(inlineFrameEl)
    await expect(inlineFrame.locator('[data-viz-select="入口命令"]')).toHaveAttribute('data-active', 'true')
    const phaseRailOverflow = await inlineFrame.evaluate(() => {
      const rail = document.querySelector('.viz-lanes')
      return rail ? rail.scrollWidth - rail.clientWidth : null
    })
    expect(phaseRailOverflow).toBe(0)

    const requestsBeforeLocalInteract = nova.provider.requests.length
    await inlineFrame.locator('[data-viz-select="沙箱执行工具"]').click()
    await expect(inlineFrame.locator('[data-viz-select="沙箱执行工具"]')).toHaveAttribute('data-active', 'true')
    expect(nova.provider.requests).toHaveLength(requestsBeforeLocalInteract)

    const inlineShotPath = path.join(screenshotDir, 'intelligent-ui-1-learning-composer-and-inline-16step.png')
    await nova.page.screenshot({ path: inlineShotPath, animations: 'disabled' })
    await testInfo.attach('intelligent-ui-1-learning-composer-and-inline-16step.png', {
      path: inlineShotPath,
      contentType: 'image/png'
    })

    await card.getByRole('button', { name: '展开', exact: true }).click()
    const dialog = nova.page.getByRole('dialog', { name: 'miniagent-ts 数据流转：从一句话到最终答案' })
    await expect(dialog).toBeVisible()
    const modalFrameEl = dialog.getByTestId('visualization-frame')
    const modalFrame = await contentFrameOf(modalFrameEl)
    await expect(modalFrame.locator('[data-viz-select="入口命令"]')).toHaveAttribute('data-active', 'true')

    await modalFrame.locator('[data-viz-select="消息事务落盘"]').click()
    await expect(modalFrame.locator('[data-viz-select="消息事务落盘"]')).toHaveAttribute('data-active', 'true')

    await expect
      .poll(async () => {
        const frameBox = await modalFrameEl.boundingBox()
        const contentHeight = await modalFrame.evaluate(() => {
          const draft = document.querySelector('.viz-draft')
          return draft ? Math.ceil(draft.getBoundingClientRect().height + 32) : 0
        })
        if (!frameBox || !contentHeight) return 999
        return frameBox.height - contentHeight
      })
      .toBeLessThanOrEqual(1)

    const modalShotPath = path.join(screenshotDir, 'intelligent-ui-2-modal-16step-phased-workbench.png')
    await nova.page.screenshot({ path: modalShotPath, animations: 'disabled' })
    await testInfo.attach('intelligent-ui-2-modal-16step-phased-workbench.png', {
      path: modalShotPath,
      contentType: 'image/png'
    })

    await nova.page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await expect(nova.page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await nova.page.waitForTimeout(150)
    const darkModalShotPath = path.join(screenshotDir, 'intelligent-ui-4-dark-modal-16step-phased-workbench.png')
    await nova.page.screenshot({ path: darkModalShotPath, animations: 'disabled' })
    await testInfo.attach('intelligent-ui-4-dark-modal-16step-phased-workbench.png', {
      path: darkModalShotPath,
      contentType: 'image/png'
    })
    await nova.page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))

    await dialog.getByRole('button', { name: '关闭' }).click()
    await expect(dialog).toHaveCount(0)

    await nova.page.waitForTimeout(1_100)
    nova.provider.enqueue({ kind: 'text', text: 'STEP_11_DEEP_DIVE_ACK' })
    await inlineFrame.locator('[data-viz-ask]').click()
    await expect(learningMain(nova).getByRole('article', { name: 'Message from user' }).last()).toContainText(
      '沙箱执行工具'
    )
    await expect(nova.page.getByText('STEP_11_DEEP_DIVE_ACK', { exact: false })).toBeVisible()
    await waitLearnTurnSettled(nova, sessionId)

    // 第三轮：同一份比较内容用固定 Before/After/Changes 视图切换
    const compareWorkbenchDraft = `## 状态同步方案取舍

\`\`\`comparison views=Before,After,Changes
维度 | 高可靠一致性场景
状态 Owner | SessionStore 单一写入源，崩溃恢复零分叉
首帧反馈 | message_start 即时触发对账
恢复 | SQLite 事务保证一致
---
维度 | 首屏即时反馈场景
状态 Owner | 本地直推，但被拒时需回滚列表
首帧反馈 | 本地直推，立即上屏
恢复 | 未落盘状态在重载后丢失
---
维度 | 关键变化
推荐 | 受信任投递 + 即时对账
原因 | 同时保留单一写入源与即时反馈
\`\`\``

    nova.provider.enqueue(
      {
        kind: 'tool',
        name: 'present_visualization',
        arguments: { title: '状态同步架构方案对比', draft: compareWorkbenchDraft },
        callId: 'call_compare_viz'
      },
      { kind: 'text', text: '上面对比了两种状态同步架构在一致性与首屏反馈上的取舍。' }
    )
    await sendLearningPrompt(nova, '为什么采用受信任投递加即时对账，对比一下备选方案？')
    await expect(
      nova.page.getByText('上面对比了两种状态同步架构在一致性与首屏反馈上的取舍', { exact: false })
    ).toBeVisible({ timeout: 30_000 })
    await waitLearnTurnSettled(nova, sessionId)

    const compareCard = nova.page.getByTestId('visualization-card').nth(1)
    await expect(compareCard).toHaveAttribute('data-state', 'ok')
    const compareFrame = await contentFrameOf(await settledFrame(compareCard))
    await compareFrame.locator('[data-viz-view="1"]').click()
    await expect(compareFrame.locator('[data-viz-view-panel="1"]')).toContainText('首屏即时反馈场景')
    await expect(compareFrame.locator('[data-viz-view-panel="0"]')).toBeHidden()

    const compareShotPath = path.join(screenshotDir, 'intelligent-ui-3-architecture-comparison-matrix.png')
    await nova.page.screenshot({ path: compareShotPath, animations: 'disabled' })
    await testInfo.attach('intelligent-ui-3-architecture-comparison-matrix.png', {
      path: compareShotPath,
      contentType: 'image/png'
    })

    // 第四轮：无效比较被诊断打回，再发布确定性依赖盘点与图表
    const imbalancedSplitDraft = '## 失衡双栏反例\n\n```comparison\n只有一列\n```'
    const techStackSandboxDraft = `## miniagent-ts · 项目分析

\`\`\`chart type=bar unit=个
依赖状态 | 数量
声明依赖 | 6
实际使用 | 3
疑似冗余 | 3
\`\`\`

\`\`\`kv
openai | ^4.55.0 · 大模型 API 调用 · 在用
chalk | ^5.3.0 · 终端彩色日志 · 在用
dotenv | ^16.4.5 · 读取环境变量 · 在用
node-fetch | ^3.3.2 · HTTP 请求 · 未接线
systeminformation | ^5.21.20 · 系统信息读取 · 未接线
tiktoken | ^1.0.20 · Token 数量估算 · 未接线
\`\`\`

\`\`\`callout tone=warning title=关键取舍
当前项目使用字符与消息预算估算上下文容量，未实际引入 tiktoken；不要仅凭声明依赖判断真实接线。
\`\`\``

    nova.provider.enqueue(
      {
        kind: 'tool',
        name: 'present_visualization',
        arguments: { title: '失衡双栏反例', draft: imbalancedSplitDraft },
        callId: 'call_bad_split'
      },
      {
        kind: 'tool',
        name: 'present_visualization',
        arguments: { title: 'miniagent-ts · 项目分析', draft: techStackSandboxDraft },
        callId: 'call_tech_stack_sandbox'
      },
      { kind: 'text', text: '上面展示了 miniagent-ts 的声明依赖、实际接线情况与取舍说明。' }
    )
    await sendLearningPrompt(nova, '盘点一下 miniagent-ts 的技术栈与实际依赖')
    await expect(
      nova.page.getByText('上面展示了 miniagent-ts 的声明依赖、实际接线情况与取舍说明', { exact: false })
    ).toBeVisible({ timeout: 30_000 })
    await waitLearnTurnSettled(nova, sessionId)

    await expect(nova.page.getByTestId('visualization-card')).toHaveCount(3)
    const techCard = nova.page.getByTestId('visualization-card').nth(2)
    await expect(techCard).toHaveAttribute('data-state', 'ok')
    const techFrame = await contentFrameOf(await settledFrame(techCard))
    await expect(techFrame.locator('.viz-draft-kv')).toContainText('tiktoken')
    await expect(techFrame.locator('.viz-draft-chart')).toBeVisible()

    const layout = await techFrame.evaluate(() => {
      const root = document.querySelector('.viz-draft')!
      const panel = document.querySelector('.viz-draft-panel')!.getBoundingClientRect()
      return { overflow: root.scrollWidth - root.clientWidth, panelWidth: Math.round(panel.width), rootWidth: Math.round(root.getBoundingClientRect().width) }
    })
    expect(layout.overflow).toBeLessThanOrEqual(0)
    expect(layout.panelWidth).toBe(layout.rootWidth)

    // 切换到深色主题截取与用户参考图 2 对齐的「技术栈与依赖沙盘」内联卡片截图
    await nova.page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await expect(nova.page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await nova.page.waitForTimeout(150)
    const techShotPath = path.join(screenshotDir, 'intelligent-ui-5-dark-tech-stack-sandbox.png')
    await techCard.screenshot({ path: techShotPath, animations: 'disabled' })
    await testInfo.attach('intelligent-ui-5-dark-tech-stack-sandbox.png', {
      path: techShotPath,
      contentType: 'image/png'
    })
    await nova.page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))

    expect(nova.pageErrors).toEqual([])
  })
})
