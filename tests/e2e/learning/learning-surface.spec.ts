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

test.describe('学习表面主路径', () => {
  test('进入学习不改动开发会话，空状态与大纲入口可辨', async ({ nova }) => {
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

    // 分段切换处于学习态；空状态给三条起点建议
    await expect(nova.page.getByRole('button', { name: '学习' }).first()).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    for (const label of ['帮我挑个入门的起点', '这个项目解决什么问题？', '从启动开始讲它怎么跑起来']) {
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
})
