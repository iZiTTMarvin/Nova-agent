import { mkdtempSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { createLearningDbHarness, learningWorkerJs } from './learningTestHarness'
import { applyLearningCommand } from '../../../src/main/learning/LearningHost'
import type { LearningCommand } from '../../../src/shared/learning/command'
import { createLearningContextTool } from '../../../src/runtime/tools/learning_context'
import { createLearningAssessTool } from '../../../src/runtime/tools/learning_assess'
import { createReadState } from '../../../src/runtime/tools/editTool'

const sampleRubricJson =
  '{"targetClaim":"指出数据来源","knowledgeRevision":"rev-1","verificationMethod":"open_answer","criteria":"能说明刷新后数据从哪读取"}'

describe('learning vertical path integration', () => {
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
    if (!existsSync(learningWorkerJs)) {
      throw new Error(`缺少 ${learningWorkerJs}，请先 npm run build`)
    }
    tempDir = mkdtempSync(join(tmpdir(), 'nova-learning-vertical-'))
    const harness = await createLearningDbHarness(join(tempDir, 'learning.db'))
    return { harness, workspace: join(tempDir, 'ws') }
  }

  it('选点后 coachTurn 文案；停点含冻结判据；context 可读教材出处', async () => {
    const { harness, workspace } = await openHarness()
    await harness.knowledge.publishVersion({
      workspaceRoot: workspace,
      knowledgeRevision: 'rev-1',
      parentRevision: null,
      inputFingerprint: 'fp',
      expectedCurrentRevision: null,
      nodes: [
        {
          nodeId: 'node-save',
          nodeRevision: 'nr-1',
          title: '保存路径',
          bodyJson: JSON.stringify({
            materialStatus: 'verified',
            navDimension: 'data_flow',
            parentNodeId: null,
            paragraphs: [{ kind: 'text', text: '数据写入 sqlite' }]
          })
        }
      ],
      members: [{ nodeId: 'node-save', nodeRevision: 'nr-1' }],
      edges: [],
      sourceReceipts: [
        {
          receiptId: 'rcpt-1',
          filePath: 'src/db.ts',
          startLine: 1,
          endLine: 3,
          contentHash: 'h1',
          snippetHash: 'sh1',
          symbolLabel: null,
          strategyVersion: 'learning-evidence-v1',
          collectedAt: Date.now()
        }
      ],
      nodeSources: [{ nodeId: 'node-save', nodeRevision: 'nr-1', receiptId: 'rcpt-1' }]
    })

    const command: LearningCommand = {
      commandId: 'cmd-select',
      sessionId: 'sess-v',
      expectedClearGeneration: 0,
      expectedCursorVersion: 0,
      action: { type: 'select_node', nodeId: 'node-save' }
    }
    const applied = await applyLearningCommand(harness.progress, workspace, command)
    expect(applied.receipt.ok).toBe(true)
    expect(applied.coachTurn).toContain('node-save')

    await harness.progress.saveCheckpoint({
      workspaceRoot: workspace,
      sessionId: 'sess-v',
      runId: 'run-v',
      checkpointId: 'ckpt-v',
      cursorVersion: 1,
      question: '刷新后数据从哪来？',
      rubricJson: sampleRubricJson
    })

    const contextTool = createLearningContextTool({ getProgress: () => harness.progress })
    const ctx = await contextTool.execute(
      { page: 0 },
      {
        workingDir: workspace,
        readState: createReadState(),
        sessionId: 'sess-v',
        runId: 'run-v',
        mode: 'learn'
      }
    )
    expect(ctx.success).toBe(true)
    const payload = JSON.parse(ctx.output) as {
      material: { sources: { receiptId: string }[] } | null
    }
    expect(payload.material?.sources[0]?.receiptId).toBe('rcpt-1')
    await harness.close()
  })

  it('回答评估引用原文；错误原话拒绝；hint 后不能记无帮助理解', async () => {
    const { harness, workspace } = await openHarness()
    await harness.progress.saveCheckpoint({
      workspaceRoot: workspace,
      sessionId: 'sess-assess',
      runId: 'run-a',
      checkpointId: 'ckpt-a',
      cursorVersion: 0,
      question: 'Q',
      rubricJson: sampleRubricJson
    })
    const answerReceipt = await harness.progress.applyCommand({
      commandId: 'cmd-ans',
      sessionId: 'sess-assess',
      expectedClearGeneration: 0,
      expectedCursorVersion: 1,
      action: { type: 'answer', checkpointId: 'ckpt-a', text: '来自 sqlite 表', optionIds: [] }
    })
    expect(answerReceipt.ok).toBe(true)
    const cursor = await harness.progress.getCursor(workspace, 'sess-assess')

    const assessTool = createLearningAssessTool({ getProgress: () => harness.progress })
    const ok = await assessTool.execute(
      {
        attemptId: JSON.parse(
          (await harness.progress.getPendingOutbox('sess-assess'))!.payload_json
        ).attemptId,
        checkpointId: 'ckpt-a',
        verdict: 'needs_clarification',
        summary: '方向对但不够具体',
        userQuote: '来自 sqlite 表',
        factReferences: [],
        cursorVersion: cursor.cursorVersion
      },
      {
        workingDir: workspace,
        readState: createReadState(),
        sessionId: 'sess-assess',
        runId: 'run-assess',
        mode: 'learn'
      }
    )
    expect(ok.success).toBe(true)

    await harness.progress.saveCheckpoint({
      workspaceRoot: workspace,
      sessionId: 'sess-assess-2',
      runId: 'run-a2',
      checkpointId: 'ckpt-b',
      cursorVersion: 0,
      question: 'Q2',
      rubricJson: sampleRubricJson
    })
    await harness.progress.applyCommand({
      commandId: 'cmd-ans2',
      sessionId: 'sess-assess-2',
      expectedClearGeneration: 0,
      expectedCursorVersion: 1,
      action: { type: 'answer', checkpointId: 'ckpt-b', text: '答案B', optionIds: [] }
    })
    const cursor2 = await harness.progress.getCursor(workspace, 'sess-assess-2')
    const badQuote = await assessTool.execute(
      {
        attemptId: JSON.parse(
          (await harness.progress.getPendingOutbox('sess-assess-2'))!.payload_json
        ).attemptId,
        checkpointId: 'ckpt-b',
        verdict: 'needs_clarification',
        summary: 'x',
        userQuote: '伪造原话',
        factReferences: [],
        cursorVersion: cursor2.cursorVersion
      },
      {
        workingDir: workspace,
        readState: createReadState(),
        sessionId: 'sess-assess-2',
        runId: 'run-assess-2',
        mode: 'learn'
      }
    )
    expect(badQuote.success).toBe(false)

    await harness.progress.saveCheckpoint({
      workspaceRoot: workspace,
      sessionId: 'sess-hint',
      runId: 'run-h',
      checkpointId: 'ckpt-h',
      cursorVersion: 0,
      question: 'Qh',
      rubricJson: sampleRubricJson
    })
    await harness.progress.applyCommand({
      commandId: 'cmd-hint',
      sessionId: 'sess-hint',
      expectedClearGeneration: 0,
      expectedCursorVersion: 1,
      action: { type: 'hint', checkpointId: 'ckpt-h' }
    })
    await harness.progress.applyCommand({
      commandId: 'cmd-ans-h',
      sessionId: 'sess-hint',
      expectedClearGeneration: 0,
      expectedCursorVersion: 2,
      action: { type: 'answer', checkpointId: 'ckpt-h', text: '有提示的答案', optionIds: [] }
    })
    const cursorH = await harness.progress.getCursor(workspace, 'sess-hint')
    const blocked = await assessTool.execute(
      {
        attemptId: JSON.parse(
          (await harness.progress.getPendingOutbox('sess-hint'))!.payload_json
        ).attemptId,
        checkpointId: 'ckpt-h',
        verdict: 'understanding_observed',
        summary: '无提示掌握',
        userQuote: '有提示的答案',
        factReferences: [],
        cursorVersion: cursorH.cursorVersion
      },
      {
        workingDir: workspace,
        readState: createReadState(),
        sessionId: 'sess-hint',
        runId: 'run-h2',
        mode: 'learn'
      }
    )
    expect(blocked.success).toBe(false)
    await harness.close()
  })

  it('并发答案仅一个成功；命令重发幂等', async () => {
    const { harness, workspace } = await openHarness()
    await harness.progress.saveCheckpoint({
      workspaceRoot: workspace,
      sessionId: 'sess-race',
      runId: 'run-r',
      checkpointId: 'ckpt-r',
      cursorVersion: 0,
      question: 'Qr',
      rubricJson: sampleRubricJson
    })
    const base: LearningCommand = {
      commandId: 'cmd-r1',
      sessionId: 'sess-race',
      expectedClearGeneration: 0,
      expectedCursorVersion: 1,
      action: { type: 'answer', checkpointId: 'ckpt-r', text: 'A1', optionIds: [] }
    }
    const second: LearningCommand = { ...base, commandId: 'cmd-r2', action: { ...base.action, text: 'A2' } }
    const [first, rival] = await Promise.all([
      harness.progress.applyCommand(base),
      harness.progress.applyCommand(second)
    ])
    const okCount = [first, rival].filter(r => r.ok === true).length
    expect(okCount).toBe(1)

    const again = await harness.progress.applyCommand(base)
    expect(again).toEqual(first)
    await harness.close()
  })
})
