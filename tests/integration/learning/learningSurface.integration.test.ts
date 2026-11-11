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

  it('投影含游标、当前问题与该题最新评估', async () => {
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
    expect(surface.currentCheckpointId).toBe('ckpt-surface')
    expect(surface.questions).toEqual([expect.objectContaining({ checkpointId: 'ckpt-surface', state: 'awaiting_answer', assessment: null })])

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
        factReferences: []
      })
    })

    surface = await harness.progress.getSurface(workspace, 'sess-surface')
    expect(surface.questions[0]).toMatchObject({ state: 'answered', assessment: { verdict: 'understanding_observed', disputed: false } })

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
        factReferences: []
      })
    })
    const assessed = await harness.progress.getSurface(workspace, 'sess-dispute')
    const assessmentId = assessed.questions[0]?.assessment?.assessmentId
    expect(assessmentId).toBeTruthy()

    await harness.progress.applyCommand(
      command('sess-dispute', await cursorOf(harness, workspace, 'sess-dispute'), {
        type: 'dispute',
        assessmentId: assessmentId!,
        reason: '用户认为判断过严'
      })
    )

    const disputed = await harness.progress.getSurface(workspace, 'sess-dispute')
    expect(disputed.questions[0]?.assessment).toMatchObject({ assessmentId, verdict: 'needs_clarification', disputed: true })

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

  it('复核自由提问的评估不清空当前选中的主题', async () => {
    const { harness, workspace } = await openHarness()
    // 自由提问阶段出题：停点没有关联主题
    await harness.progress.saveCheckpoint({
      workspaceRoot: workspace,
      sessionId: 'sess-keep-topic',
      runId: 'run-keep',
      checkpointId: 'ckpt-keep',
      cursorVersion: await cursorOf(harness, workspace, 'sess-keep-topic'),
      question: '不选主题也能提问吗？',
      rubricJson: JSON.stringify({
        targetClaim: '自由提问可用',
        knowledgeRevision: null,
        verificationMethod: 'open_answer',
        criteria: '能说明提问入口'
      })
    })
    await harness.progress.applyCommand(
      command('sess-keep-topic', await cursorOf(harness, workspace, 'sess-keep-topic'), {
        type: 'answer',
        checkpointId: 'ckpt-keep',
        text: '可以',
        optionIds: []
      })
    )
    const outbox = await harness.progress.getPendingOutbox('sess-keep-topic')
    const payload = JSON.parse(outbox!.payload_json) as { attemptId: string }
    await harness.progress.submitAssessment({
      workspaceRoot: workspace,
      sessionId: 'sess-keep-topic',
      runId: 'run-keep-assess',
      cursorVersion: await cursorOf(harness, workspace, 'sess-keep-topic'),
      submissionJson: JSON.stringify({
        attemptId: payload.attemptId,
        checkpointId: 'ckpt-keep',
        verdict: 'needs_clarification',
        summary: '再说明入口',
        factReferences: []
      })
    })
    const assessed = await harness.progress.getSurface(workspace, 'sess-keep-topic')
    expect(assessed.selectedNodeId).toBeNull()

    // 事后选中主题，再回头复核自由提问的评估
    await harness.knowledge.publishVersion({
      workspaceRoot: workspace,
      knowledgeRevision: 'rev-keep',
      parentRevision: null,
      inputFingerprint: 'fp',
      expectedCurrentRevision: null,
      nodes: [{ nodeId: 'node-keep', nodeRevision: 'nv-keep', title: '主题', bodyJson: '{"summary":"s","claims":[]}' }],
      members: [{ nodeId: 'node-keep', nodeRevision: 'nv-keep' }]
    })
    const selected = await harness.progress.applyCommand(
      command('sess-keep-topic', await cursorOf(harness, workspace, 'sess-keep-topic'), {
        type: 'select_node',
        nodeId: 'node-keep'
      })
    )
    expect(selected.ok).toBe(true)

    await harness.progress.applyCommand(
      command('sess-keep-topic', await cursorOf(harness, workspace, 'sess-keep-topic'), {
        type: 'dispute',
        assessmentId: assessed.questions[0]!.assessment!.assessmentId,
        reason: '判断过严'
      })
    )

    const disputed = await harness.progress.getSurface(workspace, 'sess-keep-topic')
    expect(disputed.currentCheckpointId).toBe('ckpt-keep')
    expect(disputed.selectedNodeId).toBe('node-keep')
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
    expect(surface.questions[0]?.state).toBe('awaiting_answer')

    // 直接讲解：记为 skipped 的明确原因，同时记入帮助事件
    await harness.progress.applyCommand(
      command('sess-help', surface.cursorVersion, { type: 'explain', checkpointId: 'ckpt-help' })
    )
    surface = await harness.progress.getSurface(workspace, 'sess-help')
    expect(surface.questions[0]).toMatchObject({ state: 'skipped', question: expect.stringContaining('为什么这样写') })

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

    // 生产入口 applyLearningCommand 会先 getCursor 建立会话游标再落命令；worker 层冷 apply 需要先有游标
    await cursorOf(harness, workspace, sessionId)
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
    expect(surface.currentCheckpointId).toBeNull()
    expect(surface.questions.find(q => q.checkpointId === 'ckpt-a')?.state).toBe('superseded')

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
    expect(surface.currentCheckpointId).toBe('ckpt-b')
    expect(surface.questions.map(q => [q.checkpointId, q.state])).toEqual([['ckpt-a', 'superseded'], ['ckpt-b', 'awaiting_answer']])
    // 两次选主题各对应一条主题分隔线，顺序与命令一致
    expect(surface.topicStartMessageIds).toHaveLength(2)

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
          factReferences: []
        })
      })

    await assess('needs_clarification')
    const assessed = await harness.progress.getSurface(workspace, sessionId)
    const assessmentId = assessed.questions[0]?.assessment?.assessmentId

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
    expect(reviewed.questions[0]?.assessment?.assessmentId).not.toBe(assessmentId)
    expect(reviewed.questions[0]?.assessment).toMatchObject({ verdict: 'understanding_observed', disputed: false })

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
    const view = await harness.reader.getTreeProjection(workspace).then(tree => ({ tree }))
    expect(view.tree.nodes).toHaveLength(1)
    expect(view.tree.nodes[0]!.materialStatus).toBe('stale')
    expect(view.tree.nodes.filter(node => node.materialStatus === 'stale')).toHaveLength(1)

    const surface = await harness.progress.getSurface(workspace, 'sess-stale')
    expect(surface.cursorVersion).toBe(0)
    expect(surface.questions).toEqual([])

    await harness.close()
  })

  it('两个会话交错完成大量答题后，问题、回答与评估仍各自归属且重开一致', async () => {
    const { harness, workspace } = await openHarness()
    const sessionIds = ['sess-heavy-a', 'sess-heavy-b'] as const
    const questionCount = 100
    const cursors = new Map<string, number>(sessionIds.map(sessionId => [sessionId, 0]))

    for (let index = 0; index < questionCount; index++) {
      for (const sessionId of sessionIds) {
        const checkpointId = `ckpt-${sessionId}-${index}`
        const commandId = `cmd-${sessionId}-${index}`
        const cursorVersion = cursors.get(sessionId)!
        await harness.progress.saveCheckpoint({
          workspaceRoot: workspace,
          sessionId,
          runId: `run-${sessionId}-${index}`,
          checkpointId,
          cursorVersion,
          question: `问题-${sessionId}-${index}`,
          rubricJson: JSON.stringify({
            targetClaim: `目标-${sessionId}-${index}`,
            knowledgeRevision: null,
            verificationMethod: 'open_answer',
            criteria: '回答对应当前题目'
          })
        })
        const answer = await harness.progress.applyCommand({
          commandId,
          sessionId,
          expectedClearGeneration: 0,
          expectedCursorVersion: cursorVersion + 1,
          action: {
            type: 'answer',
            checkpointId,
            text: `回答-${sessionId}-${index}`,
            optionIds: []
          }
        })
        expect(answer.ok).toBe(true)
        const outbox = await harness.progress.getPendingOutbox(sessionId, commandId)
        const attemptId = (JSON.parse(outbox!.payload_json) as { attemptId: string }).attemptId
        await harness.progress.submitAssessment({
          workspaceRoot: workspace,
          sessionId,
          runId: `assess-${sessionId}-${index}`,
          cursorVersion: cursorVersion + 2,
          submissionJson: JSON.stringify({
            attemptId,
            checkpointId,
            verdict: index % 2 === 0 ? 'understanding_observed' : 'needs_clarification',
            summary: `评估-${sessionId}-${index}`,
            factReferences: []
          })
        })
        await harness.progress.markOutboxDelivered(commandId)
        cursors.set(sessionId, cursorVersion + 3)
      }
    }

    const expectIsolatedSurface = async (
      progress: Awaited<ReturnType<typeof createLearningDbHarness>>['progress'],
      sessionId: string
    ): Promise<void> => {
      const surface = await progress.getSurface(workspace, sessionId)
      expect(surface.cursorVersion).toBe(questionCount * 3)
      expect(surface.questions).toHaveLength(questionCount)
      for (let index = 0; index < questionCount; index++) {
        expect(surface.questions[index]).toMatchObject({
          checkpointId: `ckpt-${sessionId}-${index}`,
          question: `问题-${sessionId}-${index}`,
          state: 'answered',
          assessment: {
            verdict: index % 2 === 0 ? 'understanding_observed' : 'needs_clarification',
            summary: `评估-${sessionId}-${index}`,
            disputed: false
          }
        })
      }
      const context = await progress.getLearningContext({ workspaceRoot: workspace, sessionId, page: 0 }) as {
        attempt: { answer: string } | null
      }
      expect(context.attempt?.answer).toBe(`回答-${sessionId}-${questionCount - 1}`)
    }

    for (const sessionId of sessionIds) await expectIsolatedSurface(harness.progress, sessionId)
    await harness.close()

    const reopened = await createLearningDbHarness(join(tempDir, 'learning.db'))
    try {
      for (const sessionId of sessionIds) await expectIsolatedSurface(reopened.progress, sessionId)
    } finally {
      await reopened.close()
    }
  }, 30_000)

  it('自然对话未选主题时可通过显式 nodeId 归属大纲进度且不篡改游标选中态，非法或过期 nodeId 被拒绝', async () => {
    const { harness, workspace } = await openHarness()
    const sessionId = 'sess-natural-node'

    await harness.knowledge.publishVersion({
      workspaceRoot: workspace,
      knowledgeRevision: 'rev-nat-1',
      parentRevision: null,
      inputFingerprint: 'fp-nat-1',
      expectedCurrentRevision: null,
      nodes: [
        {
          nodeId: 'node-flow',
          nodeRevision: 'nr-flow-1',
          title: '请求链路',
          bodyJson: JSON.stringify({
            materialStatus: 'verified',
            navDimension: 'key_user_flows',
            parentNodeId: null,
            summary: '请求处理主链路',
            learningGoal: '掌握请求流转',
            claims: []
          })
        },
        {
          nodeId: 'node-legacy',
          nodeRevision: 'nr-legacy-1',
          title: '旧状态模块',
          bodyJson: JSON.stringify({
            materialStatus: 'verified',
            navDimension: 'data_and_state',
            parentNodeId: null,
            summary: '旧模块',
            learningGoal: '理解旧模块',
            claims: []
          })
        }
      ],
      members: [
        { nodeId: 'node-flow', nodeRevision: 'nr-flow-1' },
        { nodeId: 'node-legacy', nodeRevision: 'nr-legacy-1' }
      ]
    })

    const context = (await harness.progress.getLearningContext({
      workspaceRoot: workspace,
      sessionId,
      page: 0
    })) as {
      status: string
      nodeId: string | null
      outlineNodes: readonly { nodeId: string; title: string }[]
    }
    expect(context.status).toBe('ok')
    expect(context.nodeId).toBeNull()
    expect(context.outlineNodes).toEqual([
      { nodeId: 'node-flow', title: '请求链路' },
      { nodeId: 'node-legacy', title: '旧状态模块' }
    ])

    await expect(
      harness.progress.saveCheckpoint({
        workspaceRoot: workspace,
        sessionId,
        runId: 'run-invalid-node',
        checkpointId: 'ckpt-invalid-node',
        cursorVersion: await cursorOf(harness, workspace, sessionId),
        question: '未知节点问题',
        rubricJson: JSON.stringify({
          targetClaim: 'c',
          knowledgeRevision: 'rev-nat-1',
          verificationMethod: 'open_answer',
          criteria: 'c'
        }),
        nodeId: 'node-does-not-exist'
      })
    ).rejects.toThrow(/nodeId 不属于当前有效大纲/)

    await harness.progress.saveCheckpoint({
      workspaceRoot: workspace,
      sessionId,
      runId: 'run-nat-1',
      checkpointId: 'ckpt-nat-1',
      cursorVersion: await cursorOf(harness, workspace, sessionId),
      question: '请求进入后第一步经过哪一层校验？',
      rubricJson: JSON.stringify({
        targetClaim: '说明入口校验',
        knowledgeRevision: 'rev-nat-1',
        verificationMethod: 'open_answer',
        criteria: '能指出入口边界校验'
      }),
      nodeId: 'node-flow'
    })

    await harness.progress.applyCommand(
      command(sessionId, await cursorOf(harness, workspace, sessionId), {
        type: 'answer',
        checkpointId: 'ckpt-nat-1',
        text: '先经过入口边界参数校验再进入核心编排',
        optionIds: []
      })
    )
    const outbox = await harness.progress.getPendingOutbox(sessionId)
    const { attemptId } = JSON.parse(outbox!.payload_json) as { attemptId: string }
    await harness.progress.submitAssessment({
      workspaceRoot: workspace,
      sessionId,
      runId: 'run-nat-assess',
      cursorVersion: await cursorOf(harness, workspace, sessionId),
      submissionJson: JSON.stringify({
        attemptId,
        checkpointId: 'ckpt-nat-1',
        verdict: 'understanding_observed',
        summary: '独立说清入口校验顺序',
        factReferences: []
      })
    })

    const surface = await harness.progress.getSurface(workspace, sessionId)
    expect(surface.selectedNodeId).toBeNull()
    expect(surface.questions[0]?.assessment).toMatchObject({
      verdict: 'understanding_observed',
      assisted: false,
      disputed: false
    })
    expect(surface.nodeProgress).toEqual([
      { nodeId: 'node-flow', state: 'understanding_observed' }
    ])

    // 发布新版本大纲移除 node-legacy 后，过期 nodeId 不能再绑定新停点
    await harness.knowledge.publishVersion({
      workspaceRoot: workspace,
      knowledgeRevision: 'rev-nat-2',
      parentRevision: 'rev-nat-1',
      inputFingerprint: 'fp-nat-2',
      expectedCurrentRevision: 'rev-nat-1',
      nodes: [
        {
          nodeId: 'node-flow',
          nodeRevision: 'nr-flow-1',
          title: '请求链路',
          bodyJson: JSON.stringify({
            materialStatus: 'verified',
            navDimension: 'key_user_flows',
            parentNodeId: null,
            summary: '请求处理主链路',
            learningGoal: '掌握请求流转',
            claims: []
          })
        }
      ],
      members: [{ nodeId: 'node-flow', nodeRevision: 'nr-flow-1' }]
    })

    await expect(
      harness.progress.saveCheckpoint({
        workspaceRoot: workspace,
        sessionId,
        runId: 'run-stale-node',
        checkpointId: 'ckpt-stale-node',
        cursorVersion: await cursorOf(harness, workspace, sessionId),
        question: '过期节点问题',
        rubricJson: JSON.stringify({
          targetClaim: 'c',
          knowledgeRevision: 'rev-nat-2',
          verificationMethod: 'open_answer',
          criteria: 'c'
        }),
        nodeId: 'node-legacy'
      })
    ).rejects.toThrow(/nodeId 不属于当前有效大纲/)

    await harness.close()
  })
})
