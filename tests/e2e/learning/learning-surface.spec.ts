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

const LEARN_VIZ_HTML = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"></head>
<body>
  <div class="viz-card">
    <button id="explore" class="viz-btn" type="button">深入讲讲</button>
  </div>
  <script>
    document.getElementById('explore').addEventListener('click', function () {
      nova.emit('explore', { label: 'E2E 模块', prompt: '深入讲讲' });
    });
  </script>
</body>
</html>`

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

    nova.provider.enqueue(checkpointToolTurn('call_ckpt_e2e', 'CKPT_ANCHOR_TEXT'))
    await sendLearningPrompt(nova, '数据保存后刷新为什么还在？')
    await waitLearnTurnSettled(nova, sessionId)

    // 停靠面板替换输入区：同屏只有一个可编辑输入框
    const dock = learningDock(nova)
    await expect(dock).toBeVisible()
    await expect(nova.page.getByRole('button', { name: '考考我', exact: true })).toHaveCount(0)
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

    await expect(nova.page.getByRole('button', { name: '画图演示', exact: true })).toHaveCount(1)
    await expect(nova.page.getByRole('button', { name: '考考我', exact: true })).toHaveCount(1)
    nova.provider.enqueue({ kind: 'text', text: 'QUIZ_QUICK_ACTION_ACK' })
    await nova.page.getByRole('button', { name: '考考我', exact: true }).click()
    await expect(learningMain(nova).getByRole('article', { name: 'Message from user' }).last()).toHaveText(
      '按答辩老师的视角，针对刚才讲的内容考我一道题'
    )
    await expect(nova.page.getByText('QUIZ_QUICK_ACTION_ACK', { exact: false })).toBeVisible()
    await waitLearnTurnSettled(nova, sessionId)

    // 所有用户气泡与侧栏标题都不含内部指令、内部概念或 id
    await expectNoInstructionLeak(nova)
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
    await expect(learningFlow(nova).getByText('开始学习 · 应用如何启动')).toBeVisible({ timeout: 30_000 })
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

  test('学习会话里的可视化点击进入学习对话，答题期间只提示不发送', async ({ nova }) => {
    test.setTimeout(150_000)
    const sessionId = await createLearnSession(nova)

    nova.provider.enqueue(
      {
        kind: 'tool',
        name: 'present_visualization',
        arguments: { title: '学习架构图', html: LEARN_VIZ_HTML },
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
    await frame.locator('#explore').click()

    await expect(learningMain(nova).getByRole('article', { name: 'Message from user' }).last()).toContainText(
      'E2E 模块：深入讲讲'
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
    await frame.locator('#explore').click()

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

  test('学习输入框对齐开发体验：发送即刻清空草稿并上屏用户气泡、支持 MiniMax-M2.7 思考强度与 16 步阶段泳道沙盘', async ({
    nova
  }, testInfo) => {
    test.setTimeout(180_000)
    await nova.page.setViewportSize({ width: 1280, height: 860 })
    const screenshotDir = path.resolve(__dirname, '../../../test-results/e2e/intelligent-ui')
    await mkdir(screenshotDir, { recursive: true })

    // 切换模型为 MiniMax-M2.7，验证学习模式下思考强度控件与上下文用量指示器正常显示
    await nova.invoke('save-llm-registry', {
      version: 2,
      providers: [
        {
          id: 'effort-provider',
          name: 'MiniMax',
          baseUrl: nova.provider.baseUrl,
          apiKey: 'nova-e2e-key',
          enabled: true,
          models: [{ id: 'minimax-m27', modelId: 'MiniMax-M2.7', displayName: 'MiniMax-M2.7' }]
        }
      ],
      activeModel: { providerId: 'effort-provider', modelEntryId: 'minimax-m27' }
    })
    await nova.page.reload()
    const sessionId = await createLearnSession(nova)

    const main = learningMain(nova)
    await expect(main.getByRole('button', { name: '思考强度：High' })).toBeVisible()
    await expect(main.getByRole('button', { name: /上下文容量/ })).toBeVisible()
    await expect(main.getByRole('button', { name: /工作区：/ })).toBeVisible()

    // 构造 16 步反模式 HTML（单排塞 16 个胶囊按钮）：验证发布闸门直接拦截并给出分阶段泳道引导
    const crammed16Html = `<!doctype html><body><div class="bar">${Array.from(
      { length: 16 },
      (_, i) => `<button type="button">${i + 1}. 步骤</button>`
    ).join('')}</div><div class="viz-card">纯文字卡片</div></body>`

    // 构造合规的 4 阶段 × 16 步「阶段泳道 + SVG 流向 + 联动详情检视器」工作台（故意带 body min-height: 100vh 验证弹窗不留黑底空白）
    const phased16WorkbenchHtml = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<style>
  body { min-height: 100vh; }
  .flow-svg { width: 100%; height: 96px; display: block; margin-bottom: 10px; }
  .inspector-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .step-desc { font-size: .86rem; color: var(--viz-fg); margin: 0; }
</style>
</head>
<body>
<div class="viz-workbench">
  <div class="viz-toolbar">
    <div>
      <span class="viz-title">miniagent-ts 数据流转：从一句话到最终答案</span>
      <span class="viz-note" id="progressText"> · 4 个宏观阶段 / 16 个关键节点</span>
    </div>
    <div class="viz-row">
      <input id="stepSearch" class="viz-search" type="search" placeholder="筛选步骤或文件…" aria-label="筛选步骤">
      <button id="prevBtn" class="viz-btn" type="button">上一步</button>
      <button id="nextBtn" class="viz-btn" type="button">下一步</button>
    </div>
  </div>

  <div class="viz-phases" id="phaseBar"></div>

  <div class="viz-split">
    <div class="viz-canvas">
      <svg class="flow-svg" viewBox="0 0 620 88" aria-label="阶段拓扑流向图">
        <defs>
          <marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--viz-accent)"/>
          </marker>
        </defs>
        <rect x="8" y="18" width="132" height="52" rx="8" fill="var(--viz-surface)" stroke="var(--viz-accent)" stroke-width="1.5"/>
        <text x="74" y="40" text-anchor="middle" fill="var(--viz-fg)" font-size="12" font-weight="600">1. 输入与接纳</text>
        <text x="74" y="57" text-anchor="middle" fill="var(--viz-muted)" font-size="10">Steps 1–4 · CLI / Session</text>
        <line x1="140" y1="44" x2="164" y2="44" stroke="var(--viz-accent)" stroke-width="1.6" marker-end="url(#arr)"/>

        <rect x="166" y="18" width="132" height="52" rx="8" fill="var(--viz-surface)" stroke="var(--viz-border)" stroke-width="1.5"/>
        <text x="232" y="40" text-anchor="middle" fill="var(--viz-fg)" font-size="12" font-weight="600">2. 装配与推理</text>
        <text x="232" y="57" text-anchor="middle" fill="var(--viz-muted)" font-size="10">Steps 5–8 · Prompt / SSE</text>
        <line x1="298" y1="44" x2="322" y2="44" stroke="var(--viz-accent)" stroke-width="1.6" marker-end="url(#arr)"/>

        <rect x="324" y="18" width="132" height="52" rx="8" fill="var(--viz-surface)" stroke="var(--viz-border)" stroke-width="1.5"/>
        <text x="390" y="40" text-anchor="middle" fill="var(--viz-fg)" font-size="12" font-weight="600">3. 工具与沙箱</text>
        <text x="390" y="57" text-anchor="middle" fill="var(--viz-muted)" font-size="10">Steps 9–12 · Tool / Loop</text>
        <line x1="456" y1="44" x2="480" y2="44" stroke="var(--viz-accent)" stroke-width="1.6" marker-end="url(#arr)"/>

        <rect x="482" y="18" width="130" height="52" rx="8" fill="var(--viz-surface)" stroke="var(--viz-border)" stroke-width="1.5"/>
        <text x="547" y="40" text-anchor="middle" fill="var(--viz-fg)" font-size="12" font-weight="600">4. 落盘与呈现</text>
        <text x="547" y="57" text-anchor="middle" fill="var(--viz-muted)" font-size="10">Steps 13–16 · Store / UI</text>
      </svg>

      <div class="viz-lanes" id="lanesContainer"></div>
    </div>

    <div class="viz-inspector" id="inspectorPanel">
      <div class="inspector-head">
        <span class="viz-badge" id="detailPhaseBadge">阶段 1</span>
        <span class="viz-file-ref" id="detailFileRef">src/cli.ts:42</span>
      </div>
      <div class="viz-title" id="detailTitle">1. 入口命令解析</div>
      <p class="step-desc" id="detailDesc"></p>
      <dl class="viz-kv">
        <dt>输入载荷</dt><dd id="detailIn"></dd>
        <dt>输出产物</dt><dd id="detailOut"></dd>
        <dt>所属分层</dt><dd id="detailLane"></dd>
      </dl>
      <pre class="viz-code" id="detailCode"></pre>
      <div class="viz-row">
        <button id="askDeepBtn" class="viz-btn viz-btn-primary" type="button">深入讲讲这一步</button>
      </div>
    </div>
  </div>
</div>
<script>
  var PHASES = [
    { id: 1, kicker: '阶段一 · Steps 1–4', title: '输入接纳与会话初始化' },
    { id: 2, kicker: '阶段二 · Steps 5–8', title: '上下文装配与流式推理' },
    { id: 3, kicker: '阶段三 · Steps 9–12', title: '工具调度与沙箱执行' },
    { id: 4, kicker: '阶段四 · Steps 13–16', title: '结果回填、落盘与渲染' }
  ];
  var STEPS = [
    { id: 1, phase: 1, lane: '交互入口层', title: '入口命令', file: 'src/cli.ts:28', desc: '接收用户输入的原始问题文本，完成非空校验与命令分发。', input: 'rawPrompt: string', output: 'TurnRequest', code: 'const req = parseUserInput(line);\\nawait agent.runTurn(req);' },
    { id: 2, phase: 1, lane: '交互入口层', title: '命令路由', file: 'src/router.ts:54', desc: '区分斜杠命令与普通对话提问，绑定当前会话 ID。', input: 'TurnRequest', output: 'RoutedPrompt', code: 'if (req.isSlash) return runSlash(req);' },
    { id: 3, phase: 1, lane: '会话状态层', title: '消息入栈', file: 'src/session/SessionStore.ts:89', desc: '将用户消息写入会话历史并生成唯一 messageId。', input: 'RoutedPrompt', output: 'UserMessageRecord', code: 'store.appendUserMessage(sessionId, text);' },
    { id: 4, phase: 1, lane: '编排内核层', title: '回合锁获取', file: 'src/runtime/RunCoordinator.ts:63', desc: '登记运行态快照，防止同一会话并发重入。', input: 'sessionId', output: 'RunLease(thinking)', code: 'coordinator.acquire(sessionId, "thinking");' },
    { id: 5, phase: 2, lane: '编排内核层', title: '系统提示词装配', file: 'src/runtime/promptBuilder.ts:41', desc: '拼接角色约束、工作区摘要与可用工具 Schema。', input: 'SessionContext', output: 'SystemPrompt', code: 'const sys = buildSystemPrompt(workspace, tools);' },
    { id: 6, phase: 2, lane: '会话状态层', title: '历史窗口裁剪', file: 'src/runtime/contextWindow.ts:112', desc: '按上下文预算保留最近消息与前缀缓存断点。', input: 'Message[]', output: 'WindowedMessages[]', code: 'const msgs = fitContextBudget(history, 204800);' },
    { id: 7, phase: 2, lane: '模型协议层', title: '发起流式请求', file: 'src/runtime/modelClient.ts:77', desc: '向 OpenAI/Anthropic 兼容端点发送 SSE 流式请求。', input: 'ChatCompletionPayload', output: 'ReadableStream<SSE>', code: 'const stream = await client.streamChat(payload);' },
    { id: 8, phase: 2, lane: '模型协议层', title: '增量块解码', file: 'src/runtime/streamParser.ts:49', desc: '将 SSE 分片解析为思考流、正文流与工具调用参数流。', input: 'SSE Chunk', output: 'StreamDelta', code: 'yield parseDeltaChunk(rawEvent);' },
    { id: 9, phase: 3, lane: '工具沙箱层', title: '工具参数校验', file: 'src/runtime/toolDispatcher.ts:68', desc: '校验模型产出的 JSON 参数与并发安全标记。', input: 'ToolCallSpec', output: 'ValidatedToolCall', code: 'validateSchema(tool.parameters, call.args);' },
    { id: 10, phase: 3, lane: '工具沙箱层', title: '权限与副作用门禁', file: 'src/runtime/permissionGate.ts:35', desc: '只读工具直接放行，写操作或高风险命令检查授权。', input: 'ValidatedToolCall', output: 'PermissionGrant', code: 'await assertToolAllowed(call, context);' },
    { id: 11, phase: 3, lane: '工具沙箱层', title: '沙箱执行工具', file: 'src/runtime/tools/index.ts:94', desc: '在受控目录与超时边界内执行文件读取或搜索。', input: 'PermissionGrant', output: 'ToolResult', code: 'const res = await executor.execute(args, ctx);' },
    { id: 12, phase: 3, lane: '编排内核层', title: '工具结果写回', file: 'src/runtime/AgentLoop.ts:210', desc: '将工具输出追加为 tool 消息并触发下一轮模型推理。', input: 'ToolResult', output: 'NextIterationState', code: 'messages.push(toToolMessage(call.id, res));' },
    { id: 13, phase: 4, lane: '模型协议层', title: '生成最终回答', file: 'src/runtime/AgentLoop.ts:248', desc: '模型基于工具证据流式输出最终解答并收到 stop 信号。', input: 'NextIterationState', output: 'AssistantFinalText', code: 'if (finishReason === "stop") break;' },
    { id: 14, phase: 4, lane: '会话状态层', title: '消息事务落盘', file: 'src/session/SessionStore.ts:144', desc: '将完整回复、工具块与 token 统计持久化到 SQLite。', input: 'AssistantFinalText', output: 'PersistedTurn', code: 'db.transaction(() => saveTurn(turn))();' },
    { id: 15, phase: 4, lane: '编排内核层', title: '释放回合锁', file: 'src/runtime/RunCoordinator.ts:118', desc: '广播 completed 终态快照并推进排队消息。', input: 'PersistedTurn', output: 'RunSnapshot(completed)', code: 'coordinator.complete(sessionId);' },
    { id: 16, phase: 4, lane: '交互入口层', title: '最终输出呈现', file: 'src/renderer/ChatPanel.tsx:162', desc: '将流式活跃块折叠进消息列表，完成代码高亮与可视化挂载。', input: 'RunSnapshot(completed)', output: 'RenderedAnswerView', code: 'foldLiveTurnIntoMessages(messageId);' }
  ];

  var activePhase = 1;
  var activeStepId = 1;
  var filterQuery = '';

  function selectStep(stepId) {
    var step = STEPS.find(function (s) { return s.id === stepId; }) || STEPS[0];
    activeStepId = step.id;
    activePhase = step.phase;
    render();
  }

  function render() {
    var phaseBar = document.getElementById('phaseBar');
    phaseBar.innerHTML = '';
    PHASES.forEach(function (p) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'viz-phase';
      btn.setAttribute('data-active', String(p.id === activePhase && !filterQuery));
      btn.setAttribute('data-phase-id', String(p.id));
      btn.innerHTML = '<span class="viz-phase-kicker">' + p.kicker + '</span><span class="viz-phase-title">' + p.title + '</span>';
      btn.addEventListener('click', function () {
        filterQuery = '';
        document.getElementById('stepSearch').value = '';
        var firstInPhase = STEPS.find(function (s) { return s.phase === p.id; });
        if (firstInPhase) selectStep(firstInPhase.id);
      });
      phaseBar.appendChild(btn);
    });

    var visibleSteps = STEPS.filter(function (s) {
      if (filterQuery) {
        var q = filterQuery.toLowerCase();
        return s.title.toLowerCase().indexOf(q) >= 0 || s.file.toLowerCase().indexOf(q) >= 0 || s.desc.toLowerCase().indexOf(q) >= 0;
      }
      return s.phase === activePhase;
    });

    var lanes = ['交互入口层', '编排内核层', '模型协议层', '工具沙箱层', '会话状态层'];
    var lanesContainer = document.getElementById('lanesContainer');
    lanesContainer.innerHTML = '';
    lanes.forEach(function (laneName) {
      var laneSteps = visibleSteps.filter(function (s) { return s.lane === laneName; });
      if (laneSteps.length === 0) return;
      var laneEl = document.createElement('div');
      laneEl.className = 'viz-lane';
      var labelEl = document.createElement('div');
      labelEl.className = 'viz-lane-label';
      labelEl.textContent = laneName;
      var nodesEl = document.createElement('div');
      nodesEl.className = 'viz-lane-nodes';
      laneSteps.forEach(function (s, idx) {
        if (idx > 0) {
          var arr = document.createElement('span');
          arr.className = 'viz-arrow';
          arr.textContent = '→';
          nodesEl.appendChild(arr);
        }
        var node = document.createElement('button');
        node.type = 'button';
        node.className = 'viz-node';
        node.setAttribute('data-step-id', String(s.id));
        node.setAttribute('data-active', String(s.id === activeStepId));
        node.innerHTML = '<span class="viz-node-step">' + s.id + '</span><span>' + s.title + '</span>';
        node.addEventListener('click', function () { selectStep(s.id); });
        nodesEl.appendChild(node);
      });
      laneEl.appendChild(labelEl);
      laneEl.appendChild(nodesEl);
      lanesContainer.appendChild(laneEl);
    });

    var current = STEPS.find(function (s) { return s.id === activeStepId; }) || STEPS[0];
    document.getElementById('detailPhaseBadge').textContent = '阶段 ' + current.phase + ' · 第 ' + current.id + ' / 16 步';
    document.getElementById('detailFileRef').textContent = current.file;
    document.getElementById('detailTitle').textContent = current.id + '. ' + current.title;
    document.getElementById('detailDesc').textContent = current.desc;
    document.getElementById('detailIn').textContent = current.input;
    document.getElementById('detailOut').textContent = current.output;
    document.getElementById('detailLane').textContent = current.lane;
    document.getElementById('detailCode').textContent = current.code;
  }

  document.getElementById('prevBtn').addEventListener('click', function () {
    selectStep(activeStepId > 1 ? activeStepId - 1 : 16);
  });
  document.getElementById('nextBtn').addEventListener('click', function () {
    selectStep(activeStepId < 16 ? activeStepId + 1 : 1);
  });
  document.getElementById('stepSearch').addEventListener('input', function (e) {
    filterQuery = e.target.value.trim();
    render();
  });
  document.getElementById('askDeepBtn').addEventListener('click', function () {
    var current = STEPS.find(function (s) { return s.id === activeStepId; }) || STEPS[0];
    nova.emit('explore', { label: current.title, prompt: '请结合源码深入讲讲第 ' + current.id + ' 步（' + current.file + '）的异常边界' });
  });

  render();
</script>
</body>
</html>`

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

    // 第二轮：模型先尝试发布 16 个平铺胶囊按钮（被 validateVisualizationHtml 拦截），再自愈发布分阶段泳道工作台
    nova.provider.enqueue(
      {
        kind: 'tool',
        name: 'present_visualization',
        arguments: { title: '拥挤的16步胶囊条', html: crammed16Html },
        callId: 'call_crammed_16'
      },
      {
        kind: 'tool',
        name: 'present_visualization',
        arguments: { title: 'miniagent-ts 数据流转：从一句话到最终答案', html: phased16WorkbenchHtml },
        callId: 'call_phased_16'
      },
      { kind: 'text', text: '上面是按 4 个阶段拆解的 16 步完整数据流转沙盘，点击任一阶段或节点可在右侧查看载荷变化与源码位置。' }
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
    await expect(inlineFrame.locator('#detailTitle')).toHaveText('1. 入口命令')
    // 阶段名再长也只在格内折行：阶段条在内联宽度下不出现横向滚动
    const phaseRailOverflow = await inlineFrame.evaluate(() => {
      const rail = document.querySelector('.viz-phases')
      return rail ? rail.scrollWidth - rail.clientWidth : null
    })
    expect(phaseRailOverflow).toBe(0)

    // 验证本地交互（切换阶段、点击泳道节点、搜索过滤）立即刷新右侧详情面板，且不触发 nova.emit 新回合
    const requestsBeforeLocalInteract = nova.provider.requests.length
    await inlineFrame.locator('[data-phase-id="3"]').click()
    await expect(inlineFrame.locator('#detailTitle')).toHaveText('9. 工具参数校验')
    await expect(inlineFrame.locator('#detailFileRef')).toHaveText('src/runtime/toolDispatcher.ts:68')

    await inlineFrame.locator('[data-step-id="11"]').click()
    await expect(inlineFrame.locator('#detailTitle')).toHaveText('11. 沙箱执行工具')
    expect(nova.provider.requests).toHaveLength(requestsBeforeLocalInteract)

    // 留存内联视图截图（包含底部对齐开发模式的 Composer、MiniMax-M2.7 思考强度、上下文指示器与 16 步阶段泳道沙盘）
    const inlineShotPath = path.join(screenshotDir, 'intelligent-ui-1-learning-composer-and-inline-16step.png')
    await nova.page.screenshot({ path: inlineShotPath, animations: 'disabled' })
    await testInfo.attach('intelligent-ui-1-learning-composer-and-inline-16step.png', {
      path: inlineShotPath,
      contentType: 'image/png'
    })

    // 点击「展开」打开模态大视图，验证 100vh 解除绑定后弹窗高度贴合内容，无底部大片黑底空白
    await card.getByRole('button', { name: '展开' }).click()
    const dialog = nova.page.getByRole('dialog', { name: 'miniagent-ts 数据流转：从一句话到最终答案' })
    await expect(dialog).toBeVisible()
    const modalFrameEl = dialog.getByTestId('visualization-frame')
    const modalFrame = await contentFrameOf(modalFrameEl)
    await expect(modalFrame.locator('#detailTitle')).toHaveText('1. 入口命令')

    // 在弹窗内切换到阶段四并选中第 14 步「消息事务落盘」
    await modalFrame.locator('[data-phase-id="4"]').click()
    await modalFrame.locator('[data-step-id="14"]').click()
    await expect(modalFrame.locator('#detailTitle')).toHaveText('14. 消息事务落盘')

    // 验证弹窗内 iframe 高度与内部工作台实际高度紧凑贴合（差值小于 64px，彻底消除旧版几百像素的空白黑洞）
    await expect
      .poll(async () => {
        const frameBox = await modalFrameEl.boundingBox()
        const contentHeight = await modalFrame.evaluate(() => {
          const wb = document.querySelector('.viz-workbench')
          return wb ? Math.ceil(wb.getBoundingClientRect().height + 32) : 0
        })
        if (!frameBox || !contentHeight) return 999
        return Math.abs(frameBox.height - contentHeight)
      })
      .toBeLessThan(64)

    const modalShotPath = path.join(screenshotDir, 'intelligent-ui-2-modal-16step-phased-workbench.png')
    await nova.page.screenshot({ path: modalShotPath, animations: 'disabled' })
    await testInfo.attach('intelligent-ui-2-modal-16step-phased-workbench.png', {
      path: modalShotPath,
      contentType: 'image/png'
    })

    // 切换到深色主题截取展开态模态框，与原始问题二截图（深色下 16 个拥挤胶囊 + 底部黑洞空白）形成同主题直观对比
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

    // 关闭弹窗，验证点击详情面板内专门的「深入讲讲这一步」按钮会触发 nova.emit 发起追问回合
    await dialog.getByRole('button', { name: '关闭' }).click()
    await expect(dialog).toHaveCount(0)

    await nova.page.waitForTimeout(1_100)
    nova.provider.enqueue({ kind: 'text', text: 'STEP_11_DEEP_DIVE_ACK' })
    await inlineFrame.locator('#askDeepBtn').click()
    await expect(learningMain(nova).getByRole('article', { name: 'Message from user' }).last()).toContainText(
      '沙箱执行工具'
    )
    await expect(nova.page.getByText('STEP_11_DEEP_DIVE_ACK', { exact: false })).toBeVisible()
    await waitLearnTurnSettled(nova, sessionId)

    // 第三轮：软件架构与方案对比矩阵工作台（切换场景动态高亮胜出方案与指标条）
    const compareWorkbenchHtml = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"></head>
<body>
<div class="viz-workbench">
  <div class="viz-toolbar">
    <span class="viz-title">状态同步方案取舍：受信任投递 vs 渲染端直写</span>
    <div class="viz-row" id="scenarioBtns">
      <button class="viz-btn viz-btn-primary" data-scenario="consistency" type="button">优先顺序与一致性</button>
      <button class="viz-btn" data-scenario="latency" type="button">优先首屏即时反馈</button>
    </div>
  </div>
  <div class="viz-split">
    <div class="viz-canvas">
      <table class="viz-table">
        <thead>
          <tr><th>评估维度</th><th>方案 A：主进程受信任投递 + 回合起点对账（当前采用）</th><th>方案 B：渲染端多 Store 各自直写</th></tr>
        </thead>
        <tbody>
          <tr><td>状态唯一 Owner</td><td>SessionStore 单一写入源，崩溃恢复零分叉</td><td>多处乐观写入，重试或中断易产生幽灵消息</td></tr>
          <tr><td>首帧提问气泡延迟</td><td>message_start 即时触发对账（&lt; 15ms）</td><td>本地直推（0ms），但被拒时需回滚列表</td></tr>
          <tr><td>跨会话/重载恢复</td><td>SQLite 事务保证一致，任意时刻重载不丢</td><td>未落盘状态在重载后丢失</td></tr>
        </tbody>
      </table>
    </div>
    <div class="viz-inspector">
      <div class="viz-badge" id="winnerBadge">当前推荐：方案 A（受信任投递 + 即时对账）</div>
      <div class="viz-title" id="scenarioTitle">高可靠一致性场景</div>
      <p class="viz-note" id="scenarioDesc">由 LearningHost 落盘后立即通知表面刷新，并在流式回合起点同步会话消息，兼顾单一写入源与即时上屏。</p>
      <div class="viz-stat">
        <span class="viz-stat-label">一致性与可恢复得分</span>
        <div class="viz-meter"><span id="scoreBar" style="width: 96%"></span></div>
      </div>
      <span class="viz-file-ref">src/main/learning/LearningHost.ts:96</span>
    </div>
  </div>
</div>
<script>
  var btns = document.querySelectorAll('[data-scenario]');
  btns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var sc = btn.getAttribute('data-scenario');
      btns.forEach(function (b) { b.className = b === btn ? 'viz-btn viz-btn-primary' : 'viz-btn'; });
      document.getElementById('scenarioTitle').textContent = sc === 'latency' ? '首屏即时反馈场景' : '高可靠一致性场景';
      document.getElementById('scoreBar').style.width = sc === 'latency' ? '92%' : '96%';
    });
  });
</script>
</body>
</html>`

    nova.provider.enqueue(
      {
        kind: 'tool',
        name: 'present_visualization',
        arguments: { title: '状态同步架构方案对比', html: compareWorkbenchHtml },
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
    await compareFrame.locator('[data-scenario="latency"]').click()
    await expect(compareFrame.locator('#scenarioTitle')).toHaveText('首屏即时反馈场景')

    const compareShotPath = path.join(screenshotDir, 'intelligent-ui-3-architecture-comparison-matrix.png')
    await nova.page.screenshot({ path: compareShotPath, animations: 'disabled' })
    await testInfo.attach('intelligent-ui-3-architecture-comparison-matrix.png', {
      path: compareShotPath,
      contentType: 'image/png'
    })

    // 第四轮：验证「技术栈与依赖沙盘」——拦截 2fr 1fr 非对称双栏反模式，放行「顶部三指标 + 两列紧凑依赖卡网格 + 底部单栏详情」
    const imbalancedSplitHtml = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><style>.bad-split { display: grid; grid-template-columns: 2fr 1fr; gap: 12px; }</style></head>
<body><div class="bad-split"><div>左侧挤扁表格</div><div>右侧长篇安全说明</div></div></body></html>`

    const techStackSandboxHtml = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<style>
  .dep-card { cursor: pointer; text-align: left; font: inherit; color: inherit; width: 100%; }
  .dep-ver { font-family: var(--viz-font-mono); font-size: .78rem; color: var(--viz-muted); }
  .inspector-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
</style>
</head>
<body>
<div class="viz-workbench">
  <div class="viz-phases" role="tablist">
    <button class="viz-phase is-active" role="tab" aria-selected="true" type="button"><span class="viz-phase-title">依赖分析</span></button>
    <button class="viz-phase" role="tab" aria-selected="false" type="button"><span class="viz-phase-title">安全检查</span></button>
    <button class="viz-phase" role="tab" aria-selected="false" type="button"><span class="viz-phase-title">关键取舍</span></button>
  </div>

  <div class="viz-kpis">
    <div class="viz-card"><div class="viz-stat"><span class="viz-stat-value">6</span><span class="viz-stat-label">声明依赖</span></div></div>
    <div class="viz-card"><div class="viz-stat"><span class="viz-stat-value">3</span><span class="viz-stat-label">实际使用</span></div></div>
    <div class="viz-card"><div class="viz-stat"><span class="viz-stat-value">3</span><span class="viz-stat-label">疑似冗余</span></div></div>
  </div>

  <div class="viz-split">
    <div class="viz-canvas">
      <div class="viz-grid" id="depGrid">
        <button class="viz-card dep-card" data-dep="openai" type="button">
          <div class="viz-card-head"><span class="viz-title">openai</span><span class="viz-badge" data-tone="success">在用</span></div>
          <p class="viz-note">大模型 API 调用</p>
          <span class="dep-ver">^4.55.0</span>
        </button>
        <button class="viz-card dep-card" data-dep="chalk" type="button">
          <div class="viz-card-head"><span class="viz-title">chalk</span><span class="viz-badge" data-tone="success">在用</span></div>
          <p class="viz-note">终端彩色日志</p>
          <span class="dep-ver">^5.3.0</span>
        </button>
        <button class="viz-card dep-card" data-dep="dotenv" type="button">
          <div class="viz-card-head"><span class="viz-title">dotenv</span><span class="viz-badge" data-tone="success">在用</span></div>
          <p class="viz-note">读取环境变量</p>
          <span class="dep-ver">^16.4.5</span>
        </button>
        <button class="viz-card dep-card" data-dep="node-fetch" type="button">
          <div class="viz-card-head"><span class="viz-title">node-fetch</span><span class="viz-badge" data-tone="warning">未接线</span></div>
          <p class="viz-note">HTTP 请求</p>
          <span class="dep-ver">^3.3.2</span>
        </button>
        <button class="viz-card dep-card" data-dep="systeminformation" type="button">
          <div class="viz-card-head"><span class="viz-title">systeminformation</span><span class="viz-badge" data-tone="warning">未接线</span></div>
          <p class="viz-note">系统信息读取</p>
          <span class="dep-ver">^5.21.20</span>
        </button>
        <button class="viz-card dep-card is-active" data-dep="tiktoken" type="button">
          <div class="viz-card-head"><span class="viz-title">tiktoken</span><span class="viz-badge" data-tone="warning">未接线</span></div>
          <p class="viz-note">Token 数量估算</p>
          <span class="dep-ver">^1.0.20</span>
        </button>
      </div>
    </div>

    <aside class="viz-inspector" id="depInspector">
      <div class="inspector-bar">
        <span class="viz-title" id="depDetailTitle">tiktoken</span>
        <span class="viz-file-ref" id="depDetailFile">src/agent.ts:118</span>
      </div>
      <p class="viz-note" id="depDetailDesc">当前项目使用简单的字符数与消息条数估算上下文容量，未实际引入 tiktoken 分词器。</p>
    </aside>
  </div>
</div>
<script>
  var DETAILS = {
    openai: { file: 'src/llm.ts:14', desc: '唯一的 LLM 通信通道：负责发送 messages 与接收流式文本或 tool_calls。' },
    chalk: { file: 'src/logger.ts:8', desc: '用于 CLI 终端输出着色，区分日志级别标签与工具执行成功/失败图标。' },
    dotenv: { file: 'src/config.ts:5', desc: '启动时读取 .env 注入 process.env，由配置层统一读取 API Key。' },
    'node-fetch': { file: 'package.json:18', desc: '名义上给 HTTP 工具准备，实际运行直接使用 Node 18 全局 fetch。' },
    systeminformation: { file: 'package.json:19', desc: '名义上用于系统信息采集，实际环境探针由 node:os 直接手写完成。' },
    tiktoken: { file: 'src/agent.ts:118', desc: '当前项目使用简单的字符数与消息条数估算上下文容量，未实际引入 tiktoken 分词器。' }
  };
  document.querySelectorAll('[data-dep]').forEach(function (card) {
    card.addEventListener('click', function () {
      var key = card.getAttribute('data-dep');
      var info = DETAILS[key];
      if (!info) return;
      document.querySelectorAll('[data-dep]').forEach(function (c) { c.classList.toggle('is-active', c === card); });
      document.getElementById('depDetailTitle').textContent = key;
      document.getElementById('depDetailFile').textContent = info.file;
      document.getElementById('depDetailDesc').textContent = info.desc;
    });
  });
</script>
</body>
</html>`

    nova.provider.enqueue(
      {
        kind: 'tool',
        name: 'present_visualization',
        arguments: { title: '失衡双栏反例', html: imbalancedSplitHtml },
        callId: 'call_bad_split'
      },
      {
        kind: 'tool',
        name: 'present_visualization',
        arguments: { title: 'miniagent-ts · 项目分析', html: techStackSandboxHtml },
        callId: 'call_tech_stack_sandbox'
      },
      { kind: 'text', text: '上面展示了 miniagent-ts 的声明依赖、实际接线情况与取舍说明。' }
    )
    await sendLearningPrompt(nova, '盘点一下 miniagent-ts 的技术栈与实际依赖')
    await expect(
      nova.page.getByText('上面展示了 miniagent-ts 的声明依赖、实际接线情况与取舍说明', { exact: false })
    ).toBeVisible({ timeout: 30_000 })
    await waitLearnTurnSettled(nova, sessionId)

    // 只有第 3 张合规卡片被挂载（bad_split 被闸门拦截自愈）
    await expect(nova.page.getByTestId('visualization-card')).toHaveCount(3)
    const techCard = nova.page.getByTestId('visualization-card').nth(2)
    await expect(techCard).toHaveAttribute('data-state', 'ok')
    const techFrame = await contentFrameOf(await settledFrame(techCard))

    // 验证在内联聊天列宽度下，.viz-split 为上下单列堆叠（inspector 位于 canvas 正下方，不抢左右宽度）
    const splitLayout = await techFrame.evaluate(() => {
      const canvas = document.querySelector('.viz-canvas')!.getBoundingClientRect()
      const inspector = document.querySelector('.viz-inspector')!.getBoundingClientRect()
      return {
        canvasWidth: Math.round(canvas.width),
        inspectorWidth: Math.round(inspector.width),
        stackedVertically: inspector.top >= canvas.bottom - 2
      }
    })
    expect(splitLayout.stackedVertically).toBe(true)
    expect(splitLayout.canvasWidth).toBe(splitLayout.inspectorWidth)

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
