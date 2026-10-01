import { mkdtempSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CURRENT_LEARNING_SCHEMA_VERSION,
  LEARNING_SCHEMA_META_KEY
} from '../../../src/runtime/learning/storage/schema'
import { createLearningDbHarness, learningWorkerJs } from './learningTestHarness'
import type { LearningCommand } from '../../../src/shared/learning/command'

describe('learning persistence integration', () => {
  let tempDir: string

  afterEach(() => {
    if (!tempDir) return
    try {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // ignore cleanup race on Windows
    }
  })

  async function openHarness() {
    if (!existsSync(learningWorkerJs)) {
      throw new Error(`缺少构建产物 ${learningWorkerJs}，请先 npm run build`)
    }
    tempDir = mkdtempSync(join(tmpdir(), 'nova-learning-persist-'))
    const dbPath = join(tempDir, 'learning.db')
    const workspace = join(tempDir, 'ws')
    const harness = await createLearningDbHarness(dbPath)
    return { harness, dbPath, workspace }
  }

  it('重复命令返回相同回执；同 ID 不同载荷拒绝', async () => {
    const { harness, workspace } = await openHarness()
    await harness.progress.saveCheckpoint({
      workspaceRoot: workspace,
      sessionId: 'sess-a',
      runId: 'run-a',
      checkpointId: 'ckpt-a',
      cursorVersion: 0,
      question: '题目',
      rubricJson: '{"targetClaim":"t","knowledgeRevision":null,"verificationMethod":"open","criteria":"c"}'
    })

    const base: LearningCommand = {
      commandId: 'cmd-1',
      sessionId: 'sess-a',
      expectedClearGeneration: 0,
      expectedCursorVersion: 1,
      action: { type: 'resume' }
    }
    const first = await harness.progress.applyCommand(base)
    const second = await harness.progress.applyCommand(base)
    expect(first).toEqual(second)

    const conflict = await harness.progress.applyCommand({
      ...base,
      action: { type: 'message', text: '不同载荷' }
    })
    expect(conflict.ok).toBe(false)
    if (conflict.ok === false) {
      expect(conflict.code).toBe('invalid')
    }
    await harness.close()
  })

  it('回答命令先落回执再写 outbox，重开后仍在', async () => {
    const { harness, dbPath, workspace } = await openHarness()
    await harness.progress.saveCheckpoint({
      workspaceRoot: workspace,
      sessionId: 'sess-ans',
      runId: 'run-ans',
      checkpointId: 'ckpt-ans',
      cursorVersion: 0,
      question: '题目',
      rubricJson: '{"targetClaim":"t","knowledgeRevision":null,"verificationMethod":"open","criteria":"c"}'
    })
    const receipt = await harness.progress.applyCommand({
      commandId: 'cmd-ans',
      sessionId: 'sess-ans',
      expectedClearGeneration: 0,
      expectedCursorVersion: 1,
      action: { type: 'answer', checkpointId: 'ckpt-ans', text: '来自数据库', optionIds: [] }
    })
    expect(receipt.ok).toBe(true)
    await harness.close()

    const Database = (await import('better-sqlite3')).default
    const db = new Database(dbPath, { readonly: true })
    const row = db.prepare(
      `SELECT user_message_id, payload_json FROM outbox WHERE command_id = ?`
    ).get('cmd-ans') as { user_message_id: string; payload_json: string } | undefined
    db.close()
    expect(row?.user_message_id.length).toBeGreaterThan(0)
    expect(JSON.parse(row?.payload_json ?? '{}').text).toBe('来自数据库')
  })

  it('未来 schema 拒绝写入', async () => {
    const { harness, dbPath } = await openHarness()
    await harness.close()

    const Database = (await import('better-sqlite3')).default
    const db = new Database(dbPath)
    db.prepare(`UPDATE schema_meta SET value = ? WHERE key = ?`).run(
      String(CURRENT_LEARNING_SCHEMA_VERSION + 1),
      LEARNING_SCHEMA_META_KEY
    )
    db.close()

    await expect(createLearningDbHarness(dbPath)).rejects.toThrow(/高于当前支持/)
  })

  it('外键约束失败时事务回滚', async () => {
    const { harness, workspace } = await openHarness()
    await expect(
      harness.knowledge.publishVersion({
        workspaceRoot: workspace,
        knowledgeRevision: 'rev-1',
        parentRevision: null,
        inputFingerprint: 'fp',
        expectedCurrentRevision: null,
        nodes: [],
        members: [{ nodeId: 'missing', nodeRevision: 'nr-1' }]
      })
    ).rejects.toThrow()
    await harness.close()
  })

  it('清除个人记录后旧命令不能回写', async () => {
    const { harness, workspace } = await openHarness()
    await harness.progress.saveCheckpoint({
      workspaceRoot: workspace,
      sessionId: 'sess-clear',
      runId: 'run-clear',
      checkpointId: 'ckpt-clear',
      cursorVersion: 0,
      question: '题目',
      rubricJson: '{"targetClaim":"t","knowledgeRevision":null,"verificationMethod":"open","criteria":"c"}'
    })
    const gen = await harness.progress.clearPersonalRecords(workspace, 'sess-clear')
    expect(gen).toBe(1)

    const stale = await harness.progress.applyCommand({
      commandId: 'cmd-old',
      sessionId: 'sess-clear',
      expectedClearGeneration: 0,
      expectedCursorVersion: 1,
      action: { type: 'resume' }
    })
    expect(stale.ok).toBe(false)
    if (stale.ok === false) {
      expect(stale.code).toBe('stale')
    }
    await harness.close()
  })

  it('Worker 崩溃时未 ACK 操作报 unavailable', async () => {
    const { harness } = await openHarness()
    harness.client.terminateWithoutClose()
    await expect(
      harness.progress.applyCommand({
        commandId: 'cmd-crash',
        sessionId: 'sess-crash',
        expectedClearGeneration: 0,
        expectedCursorVersion: 0,
        action: { type: 'resume' }
      })
    ).rejects.toThrow(/不可用/)
  })

  it('损坏 invoke 命令被拒绝', async () => {
    const { harness } = await openHarness()
    await expect(harness.client.invoke({ domain: 'nope', op: 'x' } as never)).rejects.toThrow()
    await harness.close()
  })

  it('ProjectKnowledge 发布切换 current revision', async () => {
    const { harness, workspace } = await openHarness()
    const published = await harness.knowledge.publishVersion({
      workspaceRoot: workspace,
      knowledgeRevision: 'rev-a',
      parentRevision: null,
      inputFingerprint: 'fp-a',
      expectedCurrentRevision: null,
      nodes: [
        {
          nodeId: 'node-1',
          nodeRevision: 'nv-1',
          title: '标题',
          bodyJson: '{}'
        }
      ],
      members: [{ nodeId: 'node-1', nodeRevision: 'nv-1' }]
    })
    expect(published.knowledgeRevision).toBe('rev-a')
    await expect(
      harness.knowledge.publishVersion({
        workspaceRoot: workspace,
        knowledgeRevision: 'rev-a',
        parentRevision: null,
        inputFingerprint: 'fp-b',
        expectedCurrentRevision: 'rev-a',
        nodes: [],
        members: []
      })
    ).rejects.toThrow(/拒绝覆盖/)
    await harness.close()
  })

  it('重新生成大纲时内容相同的节点不撞主键', async () => {
    const { harness, workspace } = await openHarness()
    const node = {
      nodeId: 'node-same',
      nodeRevision: 'nv-same',
      title: '标题',
      bodyJson: '{"summary":"s","claims":[]}'
    }
    await harness.knowledge.publishVersion({
      workspaceRoot: workspace,
      knowledgeRevision: 'rev-first',
      parentRevision: null,
      inputFingerprint: 'fp-1',
      expectedCurrentRevision: null,
      nodes: [node],
      members: [{ nodeId: node.nodeId, nodeRevision: node.nodeRevision }]
    })
    const republished = await harness.knowledge.publishVersion({
      workspaceRoot: workspace,
      knowledgeRevision: 'rev-second',
      parentRevision: 'rev-first',
      inputFingerprint: 'fp-2',
      expectedCurrentRevision: 'rev-first',
      nodes: [{ ...node, title: '重新生成后的标题' }],
      members: [{ nodeId: node.nodeId, nodeRevision: node.nodeRevision }]
    })
    expect(republished.knowledgeRevision).toBe('rev-second')
    const tree = await harness.reader.getTreeProjection(workspace)
    expect(tree.nodes.map(n => n.nodeId)).toEqual([node.nodeId])
    expect(tree.nodes[0]?.title).toBe('重新生成后的标题')
    await harness.close()
  })

  it('单个节点 body 损坏不拖垮整棵大纲投影', async () => {
    const { harness, dbPath, workspace } = await openHarness()
    await harness.knowledge.publishVersion({
      workspaceRoot: workspace,
      knowledgeRevision: 'rev-tree',
      parentRevision: null,
      inputFingerprint: 'fp',
      expectedCurrentRevision: null,
      nodes: [
        { nodeId: 'node-ok', nodeRevision: 'nv-ok', title: '正常', bodyJson: '{"summary":"ok","claims":[]}' },
        { nodeId: 'node-bad', nodeRevision: 'nv-bad', title: '损坏', bodyJson: '{"summary":"bad","claims":[]}' }
      ],
      members: [
        { nodeId: 'node-ok', nodeRevision: 'nv-ok' },
        { nodeId: 'node-bad', nodeRevision: 'nv-bad' }
      ],
      edges: [{ fromNodeId: 'node-ok', toNodeId: 'node-bad', edgeKind: 'related' }]
    })

    const Database = (await import('better-sqlite3')).default
    const db = new Database(dbPath)
    db.prepare(`UPDATE node_versions SET body_json = ? WHERE node_id = ?`).run(
      '{不是合法 JSON',
      'node-bad'
    )
    db.close()

    const tree = await harness.reader.getTreeProjection(workspace)
    expect(tree.nodes.map(n => n.nodeId)).toEqual(['node-ok'])
    expect(tree.edges).toEqual([])
    await harness.close()
  })
})
