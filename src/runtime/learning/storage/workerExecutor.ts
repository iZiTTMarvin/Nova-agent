import { randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import type { LearningCommand, LearningCommandReceipt } from '../../../shared/learning/command'
import { parseLearningAssessSubmission } from '../../../shared/learning/rubric'
import type { KnowledgeEdgeKind } from '../../../shared/learning/knowledgeProjection'
import { nodeSummaryFromBody, parsePublishedNodeBody } from '../knowledge/nodeBody'
import {
  deriveProjectId,
  normalizeWorkspaceForProject,
  stablePayloadHash,
  type LearningDbWorkerOp,
  type LearningDbWorkerResult,
  type PersistedCheckpointView
} from './workerCommand'

const ALLOWED_EDGE_KINDS = new Set<KnowledgeEdgeKind>(['prerequisite', 'related', 'flow_next'])
const CONTEXT_PAGE_CHARS = 2_048

function recordHelpEvent(
  db: BetterSqlite3.Database,
  checkpointId: string,
  sessionId: string,
  projectId: string,
  kind: 'hint' | 'explain' | 'skip',
  now: number
): void {
  db.prepare(
    `INSERT INTO learning_observations (
      observation_id, attempt_id, checkpoint_id, session_id, project_id, kind, payload_json, created_at
    ) VALUES (?, NULL, ?, ?, ?, 'help_event', ?, ?)`
  ).run(randomUUID(), checkpointId, sessionId, projectId, JSON.stringify({ kind }), now)
}

function countHelpEvents(db: BetterSqlite3.Database, checkpointId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM learning_observations
       WHERE checkpoint_id = ? AND kind = 'help_event'`
    )
    .get(checkpointId) as { c: number }
  return row.c
}

function ensureProject(
  db: BetterSqlite3.Database,
  workspaceRoot: string,
  now: number
): { projectId: string; clearGeneration: number } {
  const normalized = normalizeWorkspaceForProject(workspaceRoot)
  const projectId = deriveProjectId(normalized)
  const hash = projectId
  const existing = db
    .prepare(`SELECT clear_generation FROM projects WHERE project_id = ?`)
    .get(projectId) as { clear_generation: number } | undefined
  if (existing) {
    const row = db
      .prepare(`SELECT workspace_path_hash FROM projects WHERE project_id = ?`)
      .get(projectId) as { workspace_path_hash: string }
    if (row.workspace_path_hash !== hash) {
      throw new Error('项目路径身份不匹配')
    }
    return { projectId, clearGeneration: existing.clear_generation }
  }
  db.prepare(
    `INSERT INTO projects (
      project_id, workspace_path, workspace_path_hash,
      clear_generation, current_knowledge_revision, created_at, updated_at
    ) VALUES (?, ?, ?, 0, NULL, ?, ?)`
  ).run(projectId, normalized, hash, now, now)
  return { projectId, clearGeneration: 0 }
}

function ensureCursor(
  db: BetterSqlite3.Database,
  sessionId: string,
  projectId: string,
  clearGeneration: number,
  now: number
): { cursorVersion: number; clearGeneration: number } {
  const row = db
    .prepare(
      `SELECT cursor_version, clear_generation FROM learning_cursors WHERE session_id = ?`
    )
    .get(sessionId) as { cursor_version: number; clear_generation: number } | undefined
  if (row) {
    if (row.clear_generation !== clearGeneration) {
      throw new Error('游标 clearGeneration 与项目不一致')
    }
    return { cursorVersion: row.cursor_version, clearGeneration: row.clear_generation }
  }
  db.prepare(
    `INSERT INTO learning_cursors (
      session_id, project_id, cursor_version, clear_generation, updated_at
    ) VALUES (?, ?, 0, ?, ?)`
  ).run(sessionId, projectId, clearGeneration, now)
  return { cursorVersion: 0, clearGeneration }
}

function executeSaveCheckpoint(
  db: BetterSqlite3.Database,
  op: Extract<LearningDbWorkerOp, { op: 'save_checkpoint' }>
): PersistedCheckpointView {
  const now = op.createdAt
  const { projectId, clearGeneration } = ensureProject(db, op.workspaceRoot, now)
  const cursor = ensureCursor(db, op.sessionId, projectId, clearGeneration, now)
  if (op.cursorVersion !== cursor.cursorVersion) {
    throw new Error('cursorVersion 不匹配')
  }

  const existing = db
    .prepare(`SELECT * FROM checkpoints WHERE checkpoint_id = ?`)
    .get(op.checkpointId) as Record<string, unknown> | undefined
  if (existing) {
    if (
      existing.session_id === op.sessionId &&
      existing.question === op.question &&
      existing.run_id === op.runId &&
      (existing.rubric_json as string | null) === op.rubricJson
    ) {
      return {
        checkpointId: op.checkpointId,
        sessionId: op.sessionId,
        runId: op.runId,
        cursorVersion: existing.cursor_version as number,
        question: existing.question as string,
        rubricJson: (existing.rubric_json as string | null) ?? null,
        createdAt: existing.created_at as number,
        state: existing.state as string
      }
    }
    throw new Error('checkpointId 已被不同内容占用')
  }

  const active = db
    .prepare(
      `SELECT checkpoint_id FROM checkpoints
       WHERE session_id = ? AND state IN ('awaiting_answer','answer_pending')`
    )
    .all(op.sessionId) as { checkpoint_id: string }[]
  if (active.length > 0 && active[0]!.checkpoint_id !== op.checkpointId) {
    throw new Error('会话已有进行中的停点')
  }

  db.prepare(
    `INSERT INTO checkpoints (
      checkpoint_id, session_id, project_id, run_id, cursor_version,
      question, rubric_json, state, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_answer', ?, ?)`
  ).run(
    op.checkpointId,
    op.sessionId,
    projectId,
    op.runId,
    op.cursorVersion,
    op.question,
    op.rubricJson,
    now,
    now
  )

  const nextVersion = op.cursorVersion + 1
  db.prepare(
    `UPDATE learning_cursors SET
      cursor_version = ?, current_checkpoint_id = ?, updated_at = ?
     WHERE session_id = ?`
  ).run(nextVersion, op.checkpointId, now, op.sessionId)

  return {
    checkpointId: op.checkpointId,
    sessionId: op.sessionId,
    runId: op.runId,
    cursorVersion: op.cursorVersion,
    question: op.question,
    rubricJson: op.rubricJson,
    createdAt: now,
    state: 'awaiting_answer'
  }
}

function executeGetCheckpoint(
  db: BetterSqlite3.Database,
  sessionId: string
): PersistedCheckpointView | null {
  const row = db
    .prepare(
      `SELECT c.* FROM checkpoints c
       INNER JOIN learning_cursors lc ON lc.current_checkpoint_id = c.checkpoint_id
       WHERE lc.session_id = ?`
    )
    .get(sessionId) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    checkpointId: row.checkpoint_id as string,
    sessionId: row.session_id as string,
    runId: row.run_id as string,
    cursorVersion: row.cursor_version as number,
    question: row.question as string,
    rubricJson: (row.rubric_json as string | null) ?? null,
    createdAt: row.created_at as number,
    state: row.state as string
  }
}

function staleReceipt(message: string): LearningCommandReceipt {
  return { ok: false, code: 'stale', message }
}

function invalidReceipt(message: string): LearningCommandReceipt {
  return { ok: false, code: 'invalid', message }
}

interface CommandMutation {
  readonly receipt: LearningCommandReceipt
  readonly outbox?: {
    readonly userMessageId: string
    readonly payloadJson: string
  }
}

function mutation(receipt: LearningCommandReceipt): CommandMutation {
  return { receipt }
}

function executeApplyCommand(
  db: BetterSqlite3.Database,
  command: LearningCommand
): LearningCommandReceipt {
  const now = Date.now()
  const payloadHash = stablePayloadHash(command)
  const projectRow = db
    .prepare(
      `SELECT p.project_id, p.clear_generation, lc.cursor_version, lc.clear_generation AS cursor_clear
       FROM learning_cursors lc
       INNER JOIN projects p ON p.project_id = lc.project_id
       WHERE lc.session_id = ?`
    )
    .get(command.sessionId) as
    | {
        project_id: string
        clear_generation: number
        cursor_version: number
        cursor_clear: number
      }
    | undefined

  if (!projectRow) {
    return invalidReceipt('会话游标不存在')
  }
  if (projectRow.clear_generation !== projectRow.cursor_clear) {
    return staleReceipt('clearGeneration 不一致')
  }
  if (command.expectedClearGeneration !== projectRow.clear_generation) {
    return staleReceipt('clearGeneration 已变化')
  }

  const existing = db
    .prepare(`SELECT payload_hash, receipt_json FROM learning_commands WHERE command_id = ?`)
    .get(command.commandId) as { payload_hash: string; receipt_json: string } | undefined
  if (existing) {
    if (existing.payload_hash !== payloadHash) {
      return invalidReceipt('相同 commandId 载荷不一致')
    }
    return JSON.parse(existing.receipt_json) as LearningCommandReceipt
  }

  if (command.expectedCursorVersion !== projectRow.cursor_version) {
    return staleReceipt('cursorVersion 已变化')
  }

  const applied = applyCommandMutation(db, command, projectRow.project_id, now)
  if (applied.receipt.ok === true) {
    db.prepare(
      `INSERT INTO learning_commands (
        command_id, session_id, project_id, payload_hash, receipt_json,
        clear_generation, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      command.commandId,
      command.sessionId,
      projectRow.project_id,
      payloadHash,
      JSON.stringify(applied.receipt),
      projectRow.clear_generation,
      now
    )
    if (applied.outbox) {
      db.prepare(
        `INSERT INTO outbox (
          outbox_id, command_id, session_id, project_id, user_message_id,
          payload_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
      ).run(
        randomUUID(),
        command.commandId,
        command.sessionId,
        projectRow.project_id,
        applied.outbox.userMessageId,
        applied.outbox.payloadJson,
        now
      )
    }
  }
  return applied.receipt
}

function applyCommandMutation(
  db: BetterSqlite3.Database,
  command: LearningCommand,
  projectId: string,
  now: number
): CommandMutation {
  const action = command.action
  if (action.type === 'resume') {
    const cursor = db
      .prepare(`SELECT cursor_version FROM learning_cursors WHERE session_id = ?`)
      .get(command.sessionId) as { cursor_version: number }
    return mutation({
      ok: true,
      commandId: command.commandId,
      cursorVersion: cursor.cursor_version,
      applied: true
    })
  }

  if (action.type === 'answer') {
    const claimed = db
      .prepare(
        `UPDATE checkpoints SET state = 'answer_pending', updated_at = ?
         WHERE checkpoint_id = ? AND session_id = ? AND state = 'awaiting_answer'`
      )
      .run(now, action.checkpointId, command.sessionId)
    if (claimed.changes === 0) {
      return mutation(staleReceipt('停点不可回答'))
    }
    const attemptId = randomUUID()
    db.prepare(
      `INSERT INTO attempts (
        attempt_id, checkpoint_id, session_id, project_id, answer_excerpt, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(attemptId, action.checkpointId, command.sessionId, projectId, action.text, now)
    const userMessageId = randomUUID()
    const nextVersion = (command.expectedCursorVersion as number) + 1
    db.prepare(
      `UPDATE learning_cursors SET cursor_version = ?, updated_at = ? WHERE session_id = ?`
    ).run(nextVersion, now, command.sessionId)
    return {
      receipt: {
        ok: true,
        commandId: command.commandId,
        cursorVersion: nextVersion,
        applied: true
      },
      outbox: {
        userMessageId,
        payloadJson: JSON.stringify({
          kind: 'deliver_answer',
          attemptId,
          checkpointId: action.checkpointId,
          text: action.text,
          optionIds: action.optionIds
        })
      }
    }
  }

  if (action.type === 'skip' || action.type === 'hint' || action.type === 'explain') {
    const checkpoint = db
      .prepare(`SELECT state FROM checkpoints WHERE checkpoint_id = ? AND session_id = ?`)
      .get(action.checkpointId, command.sessionId) as { state: string } | undefined
    if (!checkpoint) {
      return mutation(staleReceipt('停点不存在'))
    }
    recordHelpEvent(db, action.checkpointId, command.sessionId, projectId, action.type, now)
    if (action.type === 'skip' && checkpoint.state === 'awaiting_answer') {
      db.prepare(
        `UPDATE checkpoints SET state = 'skipped', updated_at = ? WHERE checkpoint_id = ?`
      ).run(now, action.checkpointId)
    }
    const nextVersion = command.expectedCursorVersion + 1
    db.prepare(
      `UPDATE learning_cursors SET cursor_version = ?, updated_at = ? WHERE session_id = ?`
    ).run(nextVersion, now, command.sessionId)
    return mutation({
      ok: true,
      commandId: command.commandId,
      cursorVersion: nextVersion,
      applied: true
    })
  }

  if (action.type === 'select_node' || action.type === 'message') {
    const nextVersion = command.expectedCursorVersion + 1
    if (action.type === 'select_node') {
      db.prepare(
        `UPDATE learning_cursors SET
          selected_node_id = ?, cursor_version = ?, updated_at = ?
         WHERE session_id = ?`
      ).run(action.nodeId, nextVersion, now, command.sessionId)
    } else {
      db.prepare(
        `UPDATE learning_cursors SET cursor_version = ?, updated_at = ? WHERE session_id = ?`
      ).run(nextVersion, now, command.sessionId)
    }
    return mutation({
      ok: true,
      commandId: command.commandId,
      cursorVersion: nextVersion,
      applied: true
    })
  }

  return mutation(invalidReceipt('本批次未实现该 action'))
}

function executeClearPersonal(
  db: BetterSqlite3.Database,
  workspaceRoot: string,
  sessionId: string
): { clearGeneration: number } {
  const now = Date.now()
  const { projectId } = ensureProject(db, workspaceRoot, now)
  const project = db
    .prepare(`SELECT clear_generation FROM projects WHERE project_id = ?`)
    .get(projectId) as { clear_generation: number }
  const nextGen = project.clear_generation + 1
  db.prepare(
    `UPDATE projects SET clear_generation = ?, updated_at = ? WHERE project_id = ?`
  ).run(nextGen, now, projectId)

  db.prepare(`DELETE FROM outbox WHERE session_id = ?`).run(sessionId)
  db.prepare(`DELETE FROM learning_commands WHERE session_id = ?`).run(sessionId)
  db.prepare(`DELETE FROM learning_observations WHERE session_id = ?`).run(sessionId)
  db.prepare(`DELETE FROM attempts WHERE session_id = ?`).run(sessionId)
  db.prepare(`DELETE FROM checkpoints WHERE session_id = ?`).run(sessionId)
  db.prepare(`DELETE FROM learning_cursors WHERE session_id = ?`).run(sessionId)
  db.prepare(
    `INSERT INTO learning_cursors (
      session_id, project_id, cursor_version, clear_generation, updated_at
    ) VALUES (?, ?, 0, ?, ?)`
  ).run(sessionId, projectId, nextGen, now)
  return { clearGeneration: nextGen }
}

function executePublishVersion(
  db: BetterSqlite3.Database,
  op: Extract<LearningDbWorkerOp, { op: 'publish_version' }>
): { knowledgeRevision: string } {
  const now = Date.now()
  const { projectId } = ensureProject(db, op.workspaceRoot, now)
  const project = db
    .prepare(`SELECT current_knowledge_revision FROM projects WHERE project_id = ?`)
    .get(projectId) as { current_knowledge_revision: string | null }

  if (project.current_knowledge_revision !== op.expectedCurrentRevision) {
    throw new Error('当前教材 revision 与预期不符，拒绝覆盖')
  }
  if (project.current_knowledge_revision === op.knowledgeRevision) {
    throw new Error('revision 已存在，拒绝覆盖旧基线')
  }

  for (const edge of op.edges) {
    if (!ALLOWED_EDGE_KINDS.has(edge.edgeKind as KnowledgeEdgeKind)) {
      throw new Error('边类型无效')
    }
  }

  const publish = db.transaction(() => {
    db.prepare(
      `INSERT INTO knowledge_versions (
        project_id, knowledge_revision, parent_revision, input_fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?)`
    ).run(
      projectId,
      op.knowledgeRevision,
      op.parentRevision,
      op.inputFingerprint,
      now
    )

    for (const node of op.nodes) {
      db.prepare(
        `INSERT INTO node_versions (
          project_id, node_id, node_revision, title, body_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(projectId, node.nodeId, node.nodeRevision, node.title, node.bodyJson, now)
    }
    for (const member of op.members) {
      db.prepare(
        `INSERT INTO version_members (
          project_id, knowledge_revision, node_id, node_revision
        ) VALUES (?, ?, ?, ?)`
      ).run(projectId, op.knowledgeRevision, member.nodeId, member.nodeRevision)
    }
    for (const edge of op.edges) {
      db.prepare(
        `INSERT INTO knowledge_edges (
          project_id, knowledge_revision, from_node_id, to_node_id, edge_kind
        ) VALUES (?, ?, ?, ?, ?)`
      ).run(
        projectId,
        op.knowledgeRevision,
        edge.fromNodeId,
        edge.toNodeId,
        edge.edgeKind
      )
    }
    for (const receipt of op.sourceReceipts) {
      db.prepare(
        `INSERT INTO source_receipts (
          receipt_id, project_id, file_path, start_line, end_line,
          content_hash, snippet_hash, strategy_version, symbol_label, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        receipt.receiptId,
        projectId,
        receipt.filePath,
        receipt.startLine,
        receipt.endLine,
        receipt.contentHash,
        receipt.snippetHash,
        receipt.strategyVersion,
        receipt.symbolLabel,
        receipt.collectedAt
      )
    }
    for (const link of op.nodeSources) {
      db.prepare(
        `INSERT INTO node_sources (
          project_id, node_id, node_revision, receipt_id
        ) VALUES (?, ?, ?, ?)`
      ).run(projectId, link.nodeId, link.nodeRevision, link.receiptId)
    }

    db.prepare(
      `UPDATE projects SET current_knowledge_revision = ?, updated_at = ? WHERE project_id = ?`
    ).run(op.knowledgeRevision, now, projectId)
  })

  publish()
  return { knowledgeRevision: op.knowledgeRevision }
}

function executeGetCurrentRevision(
  db: BetterSqlite3.Database,
  workspaceRoot: string
): { revision: string | null } {
  const now = Date.now()
  const { projectId } = ensureProject(db, workspaceRoot, now)
  const project = db
    .prepare(`SELECT current_knowledge_revision FROM projects WHERE project_id = ?`)
    .get(projectId) as { current_knowledge_revision: string | null }
  return { revision: project.current_knowledge_revision }
}

function executeGetTreeProjection(db: BetterSqlite3.Database, workspaceRoot: string) {
  const now = Date.now()
  const { projectId } = ensureProject(db, workspaceRoot, now)
  const project = db
    .prepare(`SELECT current_knowledge_revision FROM projects WHERE project_id = ?`)
    .get(projectId) as { current_knowledge_revision: string | null }
  const revision = project.current_knowledge_revision
  if (!revision) {
    return { knowledgeRevision: null, nodes: [], edges: [] }
  }

  const memberRows = db
    .prepare(
      `SELECT vm.node_id, vm.node_revision, nv.title, nv.body_json
       FROM version_members vm
       INNER JOIN node_versions nv
         ON nv.project_id = vm.project_id
        AND nv.node_id = vm.node_id
        AND nv.node_revision = vm.node_revision
       WHERE vm.project_id = ? AND vm.knowledge_revision = ?`
    )
    .all(projectId, revision) as {
    node_id: string
    node_revision: string
    title: string
    body_json: string
  }[]

  const nodes = memberRows.map(row => {
    const body = parsePublishedNodeBody(row.body_json)
    return {
      nodeId: row.node_id,
      nodeRevision: row.node_revision,
      title: row.title,
      summary: nodeSummaryFromBody(row.title, body),
      materialStatus: body.materialStatus,
      navDimension: body.navDimension,
      parentNodeId: body.parentNodeId
    }
  })

  const edgeRows = db
    .prepare(
      `SELECT from_node_id, to_node_id, edge_kind FROM knowledge_edges
       WHERE project_id = ? AND knowledge_revision = ?`
    )
    .all(projectId, revision) as {
    from_node_id: string
    to_node_id: string
    edge_kind: string
  }[]

  const edges = edgeRows.map(row => ({
    fromNodeId: row.from_node_id,
    toNodeId: row.to_node_id,
    edgeKind: row.edge_kind as KnowledgeEdgeKind
  }))

  return { knowledgeRevision: revision, nodes, edges }
}

function executeGetNodeMaterial(
  db: BetterSqlite3.Database,
  workspaceRoot: string,
  nodeId: string
) {
  const now = Date.now()
  const { projectId } = ensureProject(db, workspaceRoot, now)
  const project = db
    .prepare(`SELECT current_knowledge_revision FROM projects WHERE project_id = ?`)
    .get(projectId) as { current_knowledge_revision: string | null }
  const revision = project.current_knowledge_revision
  if (!revision) return null

  const member = db
    .prepare(
      `SELECT vm.node_revision, nv.title, nv.body_json
       FROM version_members vm
       INNER JOIN node_versions nv
         ON nv.project_id = vm.project_id
        AND nv.node_id = vm.node_id
        AND nv.node_revision = vm.node_revision
       WHERE vm.project_id = ? AND vm.knowledge_revision = ? AND vm.node_id = ?`
    )
    .get(projectId, revision, nodeId) as
    | { node_revision: string; title: string; body_json: string }
    | undefined
  if (!member) return null

  const sourceRows = db
    .prepare(
      `SELECT sr.receipt_id, sr.file_path, sr.start_line, sr.end_line
       FROM node_sources ns
       INNER JOIN source_receipts sr ON sr.receipt_id = ns.receipt_id
       WHERE ns.project_id = ? AND ns.node_id = ? AND ns.node_revision = ?`
    )
    .all(projectId, nodeId, member.node_revision) as {
    receipt_id: string
    file_path: string
    start_line: number
    end_line: number
  }[]

  return {
    nodeId,
    nodeRevision: member.node_revision,
    title: member.title,
    bodyJson: member.body_json,
    sources: sourceRows.map(row => ({
      receiptId: row.receipt_id,
      filePath: row.file_path,
      startLine: row.start_line,
      endLine: row.end_line
    }))
  }
}

function executeSubmitAssessment(
  db: BetterSqlite3.Database,
  op: Extract<LearningDbWorkerOp, { op: 'submit_assessment' }>
): { assessmentId: string } {
  const now = op.createdAt
  const { projectId, clearGeneration } = ensureProject(db, op.workspaceRoot, now)
  const cursor = ensureCursor(db, op.sessionId, projectId, clearGeneration, now)
  if (op.cursorVersion !== cursor.cursorVersion) {
    throw new Error('cursorVersion 不匹配')
  }
  const submission = parseLearningAssessSubmission(JSON.parse(op.submissionJson))
  const checkpoint = db
    .prepare(`SELECT * FROM checkpoints WHERE checkpoint_id = ? AND session_id = ?`)
    .get(submission.checkpointId, op.sessionId) as Record<string, unknown> | undefined
  if (!checkpoint) {
    throw new Error('停点不存在')
  }
  if (checkpoint.state !== 'answer_pending' && checkpoint.state !== 'answered') {
    throw new Error('停点尚未接纳回答')
  }
  const attempt = db
    .prepare(`SELECT answer_excerpt FROM attempts WHERE attempt_id = ? AND checkpoint_id = ?`)
    .get(submission.attemptId, submission.checkpointId) as { answer_excerpt: string } | undefined
  if (!attempt) {
    throw new Error('attempt 不存在')
  }
  const answerText = attempt.answer_excerpt.trim()
  if (submission.userQuote.trim() !== answerText) {
    throw new Error('用户原话与原始回答不匹配')
  }
  for (const ref of submission.factReferences) {
    const receipt = db
      .prepare(`SELECT receipt_id FROM source_receipts WHERE receipt_id = ? AND project_id = ?`)
      .get(ref.receiptId, projectId)
    if (!receipt) {
      throw new Error(`无效出处 ${ref.receiptId}`)
    }
  }
  const helpCount = countHelpEvents(db, submission.checkpointId)
  if (submission.verdict === 'understanding_observed' && helpCount > 0) {
    throw new Error('存在提示或跳过后不能记为无帮助理解')
  }
  const assessmentId = randomUUID()
  const payload = {
    ...submission,
    derivedHelpEventCount: helpCount,
    rubricJson: checkpoint.rubric_json ?? null
  }
  db.prepare(
    `INSERT INTO learning_observations (
      observation_id, attempt_id, checkpoint_id, session_id, project_id, kind, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, 'assessment', ?, ?)`
  ).run(
    assessmentId,
    submission.attemptId,
    submission.checkpointId,
    op.sessionId,
    projectId,
    JSON.stringify(payload),
    now
  )
  db.prepare(
    `UPDATE checkpoints SET state = 'answered', updated_at = ? WHERE checkpoint_id = ?`
  ).run(now, submission.checkpointId)
  const nextVersion = op.cursorVersion + 1
  db.prepare(
    `UPDATE learning_cursors SET cursor_version = ?, updated_at = ? WHERE session_id = ?`
  ).run(nextVersion, now, op.sessionId)
  return { assessmentId }
}

function executeGetLearningContext(
  db: BetterSqlite3.Database,
  op: Extract<LearningDbWorkerOp, { op: 'get_learning_context' }>
) {
  const now = Date.now()
  const { projectId } = ensureProject(db, op.workspaceRoot, now)
  const cursorRow = db
    .prepare(
      `SELECT selected_node_id, knowledge_revision, current_checkpoint_id FROM learning_cursors WHERE session_id = ?`
    )
    .get(op.sessionId) as
    | {
        selected_node_id: string | null
        knowledge_revision: string | null
        current_checkpoint_id: string | null
      }
    | undefined
  const nodeId = op.nodeId ?? cursorRow?.selected_node_id ?? null
  let material: ReturnType<typeof executeGetNodeMaterial> = null
  if (nodeId) {
    material = executeGetNodeMaterial(db, op.workspaceRoot, nodeId)
  }
  let checkpoint: PersistedCheckpointView | null = null
  if (cursorRow?.current_checkpoint_id) {
    const row = db
      .prepare(`SELECT * FROM checkpoints WHERE checkpoint_id = ?`)
      .get(cursorRow.current_checkpoint_id) as Record<string, unknown> | undefined
    if (row) {
      checkpoint = {
        checkpointId: row.checkpoint_id as string,
        sessionId: row.session_id as string,
        runId: row.run_id as string,
        cursorVersion: row.cursor_version as number,
        question: row.question as string,
        rubricJson: (row.rubric_json as string | null) ?? null,
        createdAt: row.created_at as number,
        state: row.state as string
      }
    }
  }
  if (!material && !checkpoint) {
    return {
      status: 'empty' as const,
      message: '尚无已发布教材或进行中的停点；请先选点或等待教材整理。'
    }
  }
  const page = Math.max(0, op.page)
  let bodySlice = ''
  let bodyTotalPages = 0
  if (material?.bodyJson) {
    const full = material.bodyJson
    bodyTotalPages = Math.max(1, Math.ceil(full.length / CONTEXT_PAGE_CHARS))
    const start = page * CONTEXT_PAGE_CHARS
    bodySlice = full.slice(start, start + CONTEXT_PAGE_CHARS)
  }
  return {
    status: 'ok' as const,
    nodeId,
    knowledgeRevision: cursorRow?.knowledge_revision ?? null,
    material: material
      ? {
          nodeId: material.nodeId,
          title: material.title,
          nodeRevision: material.nodeRevision,
          sources: material.sources,
          bodyPage: page,
          bodyTotalPages,
          bodySlice
        }
      : null,
    checkpoint
  }
}

function executeGetCursor(
  db: BetterSqlite3.Database,
  workspaceRoot: string,
  sessionId: string
): { cursorVersion: number; clearGeneration: number; selectedNodeId: string | null } {
  const now = Date.now()
  const { projectId, clearGeneration } = ensureProject(db, workspaceRoot, now)
  const cursor = ensureCursor(db, sessionId, projectId, clearGeneration, now)
  const row = db
    .prepare(`SELECT selected_node_id FROM learning_cursors WHERE session_id = ?`)
    .get(sessionId) as { selected_node_id: string | null }
  return {
    cursorVersion: cursor.cursorVersion,
    clearGeneration: cursor.clearGeneration,
    selectedNodeId: row.selected_node_id
  }
}

function executeGetPendingOutbox(db: BetterSqlite3.Database, sessionId: string) {
  const row = db
    .prepare(
      `SELECT command_id, user_message_id, payload_json FROM outbox
       WHERE session_id = ? AND status = 'pending'
       ORDER BY created_at ASC LIMIT 1`
    )
    .get(sessionId) as
    | { command_id: string; user_message_id: string; payload_json: string }
    | undefined
  return row ?? null
}

function executeMarkOutboxDelivered(db: BetterSqlite3.Database, commandId: string): void {
  db.prepare(`UPDATE outbox SET status = 'delivered' WHERE command_id = ?`).run(commandId)
}

export function executeLearningDbWorkerOp(
  db: BetterSqlite3.Database,
  op: LearningDbWorkerOp
): LearningDbWorkerResult {
  if (op.domain === 'progress' && op.op === 'save_checkpoint') {
    return { ok: true, result: executeSaveCheckpoint(db, op) }
  }
  if (op.domain === 'progress' && op.op === 'get_checkpoint') {
    return { ok: true, result: executeGetCheckpoint(db, op.sessionId) }
  }
  if (op.domain === 'progress' && op.op === 'apply_command') {
    return { ok: true, result: executeApplyCommand(db, op.command) }
  }
  if (op.domain === 'progress' && op.op === 'clear_personal') {
    return { ok: true, result: executeClearPersonal(db, op.workspaceRoot, op.sessionId) }
  }
  if (op.domain === 'progress' && op.op === 'submit_assessment') {
    try {
      return { ok: true, result: executeSubmitAssessment(db, op) }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }
  if (op.domain === 'progress' && op.op === 'get_learning_context') {
    return { ok: true, result: executeGetLearningContext(db, op) }
  }
  if (op.domain === 'progress' && op.op === 'get_cursor') {
    return { ok: true, result: executeGetCursor(db, op.workspaceRoot, op.sessionId) }
  }
  if (op.domain === 'progress' && op.op === 'get_pending_outbox') {
    return { ok: true, result: executeGetPendingOutbox(db, op.sessionId) }
  }
  if (op.domain === 'progress' && op.op === 'mark_outbox_delivered') {
    executeMarkOutboxDelivered(db, op.commandId)
    return { ok: true, result: { delivered: true } }
  }
  if (op.domain === 'knowledge' && op.op === 'publish_version') {
    return { ok: true, result: executePublishVersion(db, op) }
  }
  if (op.domain === 'knowledge' && op.op === 'get_current_revision') {
    return { ok: true, result: executeGetCurrentRevision(db, op.workspaceRoot) }
  }
  if (op.domain === 'knowledge' && op.op === 'get_tree_projection') {
    return { ok: true, result: executeGetTreeProjection(db, op.workspaceRoot) }
  }
  if (op.domain === 'knowledge' && op.op === 'get_node_material') {
    return { ok: true, result: executeGetNodeMaterial(db, op.workspaceRoot, op.nodeId) }
  }
  return { ok: false, message: '未知命令' }
}
