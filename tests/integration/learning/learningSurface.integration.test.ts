import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { createLearningDbHarness, learningWorkerJs } from './learningTestHarness'
import type { LearningCommand } from '../../../src/shared/learning/command'

describe('learning surface projection', () => {
  let tempDir: string

  afterEach(() => {
    if (!tempDir) return
    try {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // ignore
    }
  })

  async function openHarness() {
    tempDir = mkdtempSync(join(tmpdir(), 'nova-learning-surface-'))
    const harness = await createLearningDbHarness(join(tempDir, 'learning.db'))
    return { harness, workspace: join(tempDir, 'ws') }
  }

  function command(
    sessionId: string,
    cursorVersion: number,
    action: LearningCommand['action']
  ): LearningCommand {
    return {
      commandId: `cmd-${Math.random().toString(36).slice(2, 10)}`,
      sessionId,
      expectedClearGeneration: 0,
      expectedCursorVersion: cursorVersion,
      action
    }
  }

  async function cursorOf(
    harness: Awaited<ReturnType<typeof createLearningDbHarness>>,
    workspace: string,
    sessionId: string
  ): Promise<number> {
    const surface = await harness.progress.getSurface(workspace, sessionId)
    return surface.cursorVersion
  }

  it('投影含游标、停点、评估与可解释计数', async () => {
    const { harness, workspace } = await openHarness()

    await harness.progress.saveCheckpoint({
      workspaceRoot: workspace,
      sessionId: 'sess-surface',
      runId: 'run-surface',
      checkpointId: 'ckpt-surface',
      cursorVersion: await cursorOf(harness, workspace, 'sess-surface'),
      question: '刷新之后这条记录还在，主要依靠哪一段？',
      rubricJson: JSON.stringify({
        targetClaim: '指出数据来源',
        knowledgeRevision: null,
        verificationMethod: 'open_answer',
        criteria: '能说明刷新后数据从哪读取'
      })
    })

    // 提问后游标已递增；空项目时计数为 0
    let surface = await harness.progress.getSurface(workspace, 'sess-surface')
    expect(surface.cursorVersion).toBe(1)
    expect(surface.clearGeneration).toBe(0)
    expect(surface.checkpoint?.state).toBe('awaiting_answer')
    expect(surface.latestAssessment).toBeNull()
    expect(surface.summary).toEqual({
      independentCount: 0,
      needsClarificationCount: 0
    })

    // 回答 → attempt 进入 outbox；评估后计数与最新评估可读
    const answerText = '应该是加载时重新查了数据库'
    await harness.progress.applyCommand(
      command('sess-surface', await cursorOf(harness, workspace, 'sess-surface'), {
        type: 'answer',
        checkpointId: 'ckpt-surface',
        text: answerText,
        optionIds: []
      })
    )
    const outbox = await harness.progress.getPendingOutbox('sess-surface')
    expect(outbox).not.toBeNull()
    const payload = JSON.parse(outbox!.payload_json) as { attemptId: string }

    await harness.progress.submitAssessment({
      workspaceRoot: workspace,
      sessionId: 'sess-surface',
      runId: 'run-assess',
      cursorVersion: await cursorOf(harness, workspace, 'sess-surface'),
      submissionJson: JSON.stringify({
        attemptId: payload.attemptId,
        checkpointId: 'ckpt-surface',
        verdict: 'understanding_observed',
        summary: '能独立指出数据来源',
        userQuote: answerText,
        factReferences: []
      })
    })

    surface = await harness.progress.getSurface(workspace, 'sess-surface')
    expect(surface.checkpoint?.state).toBe('answered')
    expect(surface.latestAssessment?.verdict).toBe('understanding_observed')
    expect(surface.latestAssessment?.disputed).toBe(false)
    expect(surface.summary.independentCount).toBe(1)

    await harness.close()
  })

  it('质疑保留原评估并记为待复核', async () => {
    const { harness, workspace } = await openHarness()

    await harness.progress.saveCheckpoint({
      workspaceRoot: workspace,
      sessionId: 'sess-dispute',
      runId: 'run-dispute',
      checkpointId: 'ckpt-dispute',
      cursorVersion: await cursorOf(harness, workspace, 'sess-dispute'),
      question: '这段实现为什么这样写？',
      rubricJson: JSON.stringify({
        targetClaim: '说明设计取舍',
        knowledgeRevision: null,
        verificationMethod: 'open_answer',
        criteria: '能说出取舍与代价'
      })
    })
    const answerText = '为了省一次查询'
    await harness.progress.applyCommand(
      command('sess-dispute', await cursorOf(harness, workspace, 'sess-dispute'), {
        type: 'answer',
        checkpointId: 'ckpt-dispute',
        text: answerText,
        optionIds: []
      })
    )
    const outbox = await harness.progress.getPendingOutbox('sess-dispute')
    const payload = JSON.parse(outbox!.payload_json) as { attemptId: string }
    await harness.progress.submitAssessment({
      workspaceRoot: workspace,
      sessionId: 'sess-dispute',
      runId: 'run-dispute-assess',
      cursorVersion: await cursorOf(harness, workspace, 'sess-dispute'),
      submissionJson: JSON.stringify({
        attemptId: payload.attemptId,
        checkpointId: 'ckpt-dispute',
        verdict: 'needs_clarification',
        summary: '还可以再确认代价',
        userQuote: answerText,
        factReferences: []
      })
    })
    const assessed = await harness.progress.getSurface(workspace, 'sess-dispute')
    const assessmentId = assessed.latestAssessment?.assessmentId
    expect(assessmentId).toBeTruthy()
    expect(assessed.summary.needsClarificationCount).toBe(1)

    await harness.progress.applyCommand(
      command('sess-dispute', await cursorOf(harness, workspace, 'sess-dispute'), {
        type: 'dispute',
        assessmentId: assessmentId!,
        reason: '用户认为判断过严'
      })
    )

    const disputed = await harness.progress.getSurface(workspace, 'sess-dispute')
    expect(disputed.latestAssessment?.assessmentId).toBe(assessmentId)
    expect(disputed.latestAssessment?.verdict).toBe('needs_clarification')
    expect(disputed.latestAssessment?.disputed).toBe(true)

    // 质疑不存在的评估：stale 拒绝
    const receipt = await harness.progress.applyCommand(
      command('sess-dispute', await cursorOf(harness, workspace, 'sess-dispute'), {
        type: 'dispute',
        assessmentId: 'not-real',
        reason: 'x'
      })
    )
    expect(receipt.ok).toBe(false)

    await harness.close()
  })

  it('提示不消费问题，跳过与直接讲解记为 skipped', async () => {
    const { harness, workspace } = await openHarness()
    await harness.progress.saveCheckpoint({
      workspaceRoot: workspace,
      sessionId: 'sess-help',
      runId: 'run-help',
      checkpointId: 'ckpt-help',
      cursorVersion: 0,
      question: '这段实现为什么这样写？',
      rubricJson: JSON.stringify({
        targetClaim: '说明设计取舍',
        knowledgeRevision: null,
        verificationMethod: 'open_answer',
        criteria: '能说出取舍与代价'
      })
    })

    // 提示：只记帮助事件，问题仍等回答
    await harness.progress.applyCommand(
      command('sess-help', 1, { type: 'hint', checkpointId: 'ckpt-help' })
    )
    let surface = await harness.progress.getSurface(workspace, 'sess-help')
    expect(surface.checkpoint?.state).toBe('awaiting_answer')

    // 直接讲解：记为 skipped 的明确原因，同时记入帮助事件
    await harness.progress.applyCommand(
      command('sess-help', surface.cursorVersion, { type: 'explain', checkpointId: 'ckpt-help' })
    )
    surface = await harness.progress.getSurface(workspace, 'sess-help')
    expect(surface.checkpoint?.state).toBe('skipped')
    expect(surface.checkpoint?.question).toContain('为什么这样写')

    await harness.close()
  })

  it('换节点后旧停点被替代，可创建新停点', async () => {
    const { harness, workspace } = await openHarness()
    const sessionId = 'sess-replace'
    await harness.knowledge.publishVersion({
      workspaceRoot: workspace,
      knowledgeRevision: 'rev-replace',
      parentRevision: null,
      inputFingerprint: 'fp-replace',
      expectedCurrentRevision: null,
      nodes: [
        {
          nodeId: 'node-a',
          nodeRevision: 'nr-a',
          title: '节点 A',
          bodyJson: JSON.stringify({
            materialStatus: 'verified',
            navDimension: 'module_roles',
            parentNodeId: null,
            summary: 'A',
            learningGoal: '学 A',
            claims: []
          })
        },
        {
          nodeId: 'node-b',
          nodeRevision: 'nr-b',
          title: '节点 B',
          bodyJson: JSON.stringify({
            materialStatus: 'verified',
            navDimension: 'module_roles',
            parentNodeId: null,
            summary: 'B',
            learningGoal: '学 B',
            claims: []
          })
        }
      ],
      members: [
        { nodeId: 'node-a', nodeRevision: 'nr-a' },
        { nodeId: 'node-b', nodeRevision: 'nr-b' }
      ],
      edges: [],
      sourceReceipts: [],
      nodeSources: []
    })

    await harness.progress.applyCommand(command(sessionId, 0, { type: 'select_node', nodeId: 'node-a' }))
    await harness.progress.saveCheckpoint({
      workspaceRoot: workspace,
      sessionId,
      runId: 'run-replace',
      checkpointId: 'ckpt-a',
      cursorVersion: await cursorOf(harness, workspace, sessionId),
      question: 'A 的问题',
      rubricJson: JSON.stringify({
        targetClaim: 't',
        knowledgeRevision: null,
        verificationMethod: 'open_answer',
        criteria: 'c'
      })
    })

    // 换到 B：A 的停点应被替代而非继续占用会话
    await harness.progress.applyCommand(
      command(sessionId, await cursorOf(harness, workspace, sessionId), {
        type: 'select_node',
        nodeId: 'node-b'
      })
    )
    let surface = await harness.progress.getSurface(workspace, sessionId)
    expect(surface.checkpoint).toBeNull()

    await harness.progress.saveCheckpoint({
      workspaceRoot: workspace,
      sessionId,
      runId: 'run-replace-2',
      checkpointId: 'ckpt-b',
      cursorVersion: await cursorOf(harness, workspace, sessionId),
      question: 'B 的问题',
      rubricJson: JSON.stringify({
        targetClaim: 't',
        knowledgeRevision: null,
        verificationMethod: 'open_answer',
        criteria: 'c'
      })
    })
    surface = await harness.progress.getSurface(workspace, sessionId)
    expect(surface.checkpoint?.checkpointId).toBe('ckpt-b')
    expect(surface.checkpoint?.state).toBe('awaiting_answer')

    await harness.close()
  })

  it('learning_context 提供当前游标版本与原回答出处', async () => {
    const { harness, workspace } = await openHarness()
    const sessionId = 'sess-context'
    await harness.progress.saveCheckpoint({
      workspaceRoot: workspace,
      sessionId,
      runId: 'run-ctx',
      checkpointId: 'ckpt-ctx',
      cursorVersion: 0,
      question: '这条数据从哪来？',
      rubricJson: JSON.stringify({
        targetClaim: 't',
        knowledgeRevision: null,
        verificationMethod: 'open_answer',
        criteria: 'c'
      })
    })
    const answerText = '从配置文件读的'
    await harness.progress.applyCommand(
      command(sessionId, await cursorOf(harness, workspace, sessionId), {
        type: 'answer',
        checkpointId: 'ckpt-ctx',
        text: answerText,
        optionIds: []
      })
    )
    const outbox = await harness.progress.getPendingOutbox(sessionId)

    const context = (await harness.progress.getLearningContext({
      workspaceRoot: workspace,
      sessionId,
      page: 0
    })) as {
      cursorVersion: number
      checkpoint: { state: string } | null
      attempt: { answer: string; messageId: string | null } | null
    }
    // 写入工具按当前游标校验：context 必须给当前版本，不能停留在停点创建时的版本
    expect(context.cursorVersion).toBe(await cursorOf(harness, workspace, sessionId))
    expect(context.checkpoint?.state).toBe('answer_pending')
    expect(context.attempt?.answer).toBe(answerText)
    expect(context.attempt?.messageId).toBe(outbox?.user_message_id)

    await harness.close()
  })

  it('质疑后可提交复核评估，未质疑的重复评估被拒绝', async () => {
    const { harness, workspace } = await openHarness()
    const sessionId = 'sess-review'
    await harness.progress.saveCheckpoint({
      workspaceRoot: workspace,
      sessionId,
      runId: 'run-review',
      checkpointId: 'ckpt-review',
      cursorVersion: 0,
      question: '为什么这样设计？',
      rubricJson: JSON.stringify({
        targetClaim: 't',
        knowledgeRevision: null,
        verificationMethod: 'open_answer',
        criteria: 'c'
      })
    })
    const answerText = '为了少一次查询'
    await harness.progress.applyCommand(
      command(sessionId, await cursorOf(harness, workspace, sessionId), {
        type: 'answer',
        checkpointId: 'ckpt-review',
        text: answerText,
        optionIds: []
      })
    )
    const outbox = await harness.progress.getPendingOutbox(sessionId)
    const payload = JSON.parse(outbox!.payload_json) as { attemptId: string }
    const assess = async (verdict: 'understanding_observed' | 'needs_clarification') =>
      harness.progress.submitAssessment({
        workspaceRoot: workspace,
        sessionId,
        runId: 'run-assess',
        cursorVersion: await cursorOf(harness, workspace, sessionId),
        submissionJson: JSON.stringify({
          attemptId: payload.attemptId,
          checkpointId: 'ckpt-review',
          verdict,
          summary: verdict === 'understanding_observed' ? '复核后确认理解' : '还需澄清',
          userQuote: answerText,
          factReferences: []
        })
      })

    await assess('needs_clarification')
    const assessed = await harness.progress.getSurface(workspace, sessionId)
    const assessmentId = assessed.latestAssessment?.assessmentId

    await harness.progress.applyCommand(
      command(sessionId, await cursorOf(harness, workspace, sessionId), {
        type: 'dispute',
        assessmentId: assessmentId!,
        reason: '判断过严'
      })
    )

    // 复核产生新评估，保留原评估为被替代记录
    await assess('understanding_observed')
    const reviewed = await harness.progress.getSurface(workspace, sessionId)
    expect(reviewed.latestAssessment?.assessmentId).not.toBe(assessmentId)
    expect(reviewed.latestAssessment?.verdict).toBe('understanding_observed')
    expect(reviewed.latestAssessment?.disputed).toBe(false)
    expect(reviewed.summary.independentCount).toBe(1)

    // 最新评估未被质疑时，同一回答不能重复评估
    await expect(assess('needs_clarification')).rejects.toThrow(/复核/)

    await harness.close()
  })

  it('多条 pending 交付意图按命令精确匹配', async () => {
    const { harness, workspace } = await openHarness()
    const sessionId = 'sess-outbox'
    await harness.progress.saveCheckpoint({
      workspaceRoot: workspace,
      sessionId,
      runId: 'run-outbox',
      checkpointId: 'ckpt-outbox',
      cursorVersion: 0,
      question: 'Q?',
      rubricJson: JSON.stringify({
        targetClaim: 't',
        knowledgeRevision: null,
        verificationMethod: 'open_answer',
        criteria: 'c'
      })
    })
    await harness.progress.applyCommand(
      command(sessionId, 1, {
        type: 'answer',
        checkpointId: 'ckpt-outbox',
        text: '回答 A',
        optionIds: []
      })
    )
    // 回答的交付意图尚未交接时，用户又发了自由消息：
    // 两条 pending 并存，各自命令必须只取到自己的意图
    const messageCommand = command(sessionId, 2, { type: 'message', text: '换个问题' })
    await harness.progress.applyCommand(messageCommand)

    const earliest = await harness.progress.getPendingOutbox(sessionId)
    expect(JSON.parse(earliest!.payload_json)).toMatchObject({ kind: 'deliver_answer' })

    const own = await harness.progress.getPendingOutbox(sessionId, messageCommand.commandId)
    expect(own?.command_id).toBe(messageCommand.commandId)
    expect(JSON.parse(own!.payload_json)).toMatchObject({ kind: 'deliver_command' })

    await harness.close()
  })

  it('过期节点在树投影中标记待复核', async () => {
    const { harness, workspace } = await openHarness()
    await harness.knowledge.publishVersion({
      workspaceRoot: workspace,
      knowledgeRevision: 'rev-stale',
      parentRevision: null,
      inputFingerprint: 'fp-stale',
      expectedCurrentRevision: null,
      nodes: [
        {
          nodeId: 'node-stale',
          nodeRevision: 'nr-stale',
          title: '旧版保存路径',
          bodyJson: JSON.stringify({
            materialStatus: 'stale',
            navDimension: 'data_and_state',
            parentNodeId: null,
            summary: '旧版结论',
            learningGoal: '复核保存路径',
            claims: []
          })
        }
      ],
      members: [{ nodeId: 'node-stale', nodeRevision: 'nr-stale' }],
      edges: [],
      sourceReceipts: [],
      nodeSources: []
    })

    // 待复核计数与界面共用同一份树投影
    const view = await harness.surface.loadView(workspace)
    expect(view.tree.nodes).toHaveLength(1)
    expect(view.tree.nodes[0]!.materialStatus).toBe('stale')
    expect(view.tree.nodes.filter(node => node.materialStatus === 'stale')).toHaveLength(1)

    const surface = await harness.progress.getSurface(workspace, 'sess-stale')
    expect(surface.cursorVersion).toBe(0)
    expect(surface.summary.independentCount).toBe(0)

    await harness.close()
  })
})
