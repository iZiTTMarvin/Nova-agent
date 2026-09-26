import { createHash } from 'node:crypto'
import { computeWorkspaceHash, normalizeWorkspaceRoot } from '../../memory/MemoryPaths'
import type { LearningCommand, LearningCommandReceipt } from '../../../shared/learning/command'
import {
  parseLearningCommand,
  parseLearningCommandReceipt
} from '../../../shared/learning/command'

export type LearningDbWorkerOp =
  | {
      domain: 'progress'
      op: 'save_checkpoint'
      workspaceRoot: string
      sessionId: string
      runId: string
      checkpointId: string
      cursorVersion: number
      question: string
      rubricJson: string
      createdAt: number
    }
  | {
      domain: 'progress'
      op: 'get_checkpoint'
      sessionId: string
    }
  | { domain: 'progress'; op: 'apply_command'; command: LearningCommand }
  | {
      domain: 'progress'
      op: 'clear_personal'
      workspaceRoot: string
      sessionId: string
    }
  | {
      domain: 'progress'
      op: 'submit_assessment'
      workspaceRoot: string
      sessionId: string
      runId: string
      cursorVersion: number
      submissionJson: string
      createdAt: number
    }
  | {
      domain: 'progress'
      op: 'get_learning_context'
      workspaceRoot: string
      sessionId: string
      nodeId?: string
      page: number
    }
  | { domain: 'progress'; op: 'get_cursor'; workspaceRoot: string; sessionId: string }
  | {
      domain: 'progress'
      op: 'get_surface'
      workspaceRoot: string
      sessionId: string
    }
  | { domain: 'progress'; op: 'get_pending_outbox'; sessionId: string; commandId?: string }
  | { domain: 'progress'; op: 'mark_outbox_delivered'; commandId: string }
  | {
      domain: 'knowledge'
      op: 'publish_version'
      workspaceRoot: string
      knowledgeRevision: string
      parentRevision: string | null
      inputFingerprint: string
      expectedCurrentRevision: string | null
      nodes: readonly {
        nodeId: string
        nodeRevision: string
        title: string
        bodyJson: string
      }[]
      members: readonly { nodeId: string; nodeRevision: string }[]
      edges: readonly {
        fromNodeId: string
        toNodeId: string
        edgeKind: string
      }[]
      sourceReceipts: readonly {
        receiptId: string
        filePath: string
        startLine: number
        endLine: number
        contentHash: string
        snippetHash: string
        symbolLabel: string | null
        strategyVersion: string
        collectedAt: number
      }[]
      nodeSources: readonly {
        nodeId: string
        nodeRevision: string
        receiptId: string
      }[]
    }
  | { domain: 'knowledge'; op: 'get_current_revision'; workspaceRoot: string }
  | { domain: 'knowledge'; op: 'get_tree_projection'; workspaceRoot: string }
  | {
      domain: 'knowledge'
      op: 'get_node_material'
      workspaceRoot: string
      nodeId: string
    }

export type LearningDbWorkerResult =
  | { ok: true; result?: unknown }
  | { ok: false; message: string }

export function deriveProjectId(workspaceRoot: string): string {
  return computeWorkspaceHash(workspaceRoot)
}

export function stablePayloadHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} 无效`)
  }
  return value.trim()
}

function readInt(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${field} 无效`)
  }
  return value as number
}

function parseEdgeList(raw: unknown, field: string) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error(`${field} 必须是数组`)
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`${field}[${index}] 无效`)
    const row = item as Record<string, unknown>
    return {
      fromNodeId: readString(row.fromNodeId, 'fromNodeId'),
      toNodeId: readString(row.toNodeId, 'toNodeId'),
      edgeKind: readString(row.edgeKind, 'edgeKind')
    }
  })
}

function parseReceiptList(raw: unknown, field: string) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error(`${field} 必须是数组`)
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`${field}[${index}] 无效`)
    const row = item as Record<string, unknown>
    return {
      receiptId: readString(row.receiptId, 'receiptId'),
      filePath: readString(row.filePath, 'filePath'),
      startLine: readInt(row.startLine, 'startLine'),
      endLine: readInt(row.endLine, 'endLine'),
      contentHash: readString(row.contentHash, 'contentHash'),
      snippetHash: readString(row.snippetHash, 'snippetHash'),
      symbolLabel:
        row.symbolLabel === null || row.symbolLabel === undefined
          ? null
          : readString(row.symbolLabel, 'symbolLabel'),
      strategyVersion: readString(row.strategyVersion, 'strategyVersion'),
      collectedAt: readInt(row.collectedAt, 'collectedAt')
    }
  })
}

function parseNodeSourceList(raw: unknown, field: string) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error(`${field} 必须是数组`)
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`${field}[${index}] 无效`)
    const row = item as Record<string, unknown>
    return {
      nodeId: readString(row.nodeId, 'nodeId'),
      nodeRevision: readString(row.nodeRevision, 'nodeRevision'),
      receiptId: readString(row.receiptId, 'receiptId')
    }
  })
}

export function parseLearningDbWorkerOp(raw: unknown): LearningDbWorkerOp {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Worker 命令必须是对象')
  }
  const value = raw as Record<string, unknown>
  const domain = value.domain
  const op = value.op
  if (domain === 'progress' && op === 'save_checkpoint') {
    return {
      domain: 'progress',
      op: 'save_checkpoint',
      workspaceRoot: readString(value.workspaceRoot, 'workspaceRoot'),
      sessionId: readString(value.sessionId, 'sessionId'),
      runId: readString(value.runId, 'runId'),
      checkpointId: readString(value.checkpointId, 'checkpointId'),
      cursorVersion: readInt(value.cursorVersion, 'cursorVersion'),
      question: readString(value.question, 'question'),
      rubricJson: readString(value.rubricJson, 'rubricJson'),
      createdAt: readInt(value.createdAt, 'createdAt')
    }
  }
  if (domain === 'progress' && op === 'get_checkpoint') {
    return {
      domain: 'progress',
      op: 'get_checkpoint',
      sessionId: readString(value.sessionId, 'sessionId')
    }
  }
  if (domain === 'progress' && op === 'apply_command') {
    return { domain: 'progress', op: 'apply_command', command: parseLearningCommand(value.command) }
  }
  if (domain === 'progress' && op === 'clear_personal') {
    return {
      domain: 'progress',
      op: 'clear_personal',
      workspaceRoot: readString(value.workspaceRoot, 'workspaceRoot'),
      sessionId: readString(value.sessionId, 'sessionId')
    }
  }
  if (domain === 'progress' && op === 'submit_assessment') {
    return {
      domain: 'progress',
      op: 'submit_assessment',
      workspaceRoot: readString(value.workspaceRoot, 'workspaceRoot'),
      sessionId: readString(value.sessionId, 'sessionId'),
      runId: readString(value.runId, 'runId'),
      cursorVersion: readInt(value.cursorVersion, 'cursorVersion'),
      submissionJson: readString(value.submissionJson, 'submissionJson'),
      createdAt: readInt(value.createdAt, 'createdAt')
    }
  }
  if (domain === 'progress' && op === 'get_learning_context') {
    return {
      domain: 'progress',
      op: 'get_learning_context',
      workspaceRoot: readString(value.workspaceRoot, 'workspaceRoot'),
      sessionId: readString(value.sessionId, 'sessionId'),
      ...(typeof value.nodeId === 'string' && value.nodeId.trim()
        ? { nodeId: value.nodeId.trim() }
        : {}),
      page: readInt(value.page ?? 0, 'page')
    }
  }
  if (domain === 'progress' && op === 'get_cursor') {
    return {
      domain: 'progress',
      op: 'get_cursor',
      workspaceRoot: readString(value.workspaceRoot, 'workspaceRoot'),
      sessionId: readString(value.sessionId, 'sessionId')
    }
  }
  if (domain === 'progress' && op === 'get_surface') {
    return {
      domain: 'progress',
      op: 'get_surface',
      workspaceRoot: readString(value.workspaceRoot, 'workspaceRoot'),
      sessionId: readString(value.sessionId, 'sessionId')
    }
  }
  if (domain === 'progress' && op === 'get_pending_outbox') {
    return {
      domain: 'progress',
      op: 'get_pending_outbox',
      sessionId: readString(value.sessionId, 'sessionId'),
      ...(typeof value.commandId === 'string' && value.commandId.trim()
        ? { commandId: value.commandId.trim() }
        : {})
    }
  }
  if (domain === 'progress' && op === 'mark_outbox_delivered') {
    return {
      domain: 'progress',
      op: 'mark_outbox_delivered',
      commandId: readString(value.commandId, 'commandId')
    }
  }
  if (domain === 'knowledge' && op === 'publish_version') {
    const nodesRaw = value.nodes
    if (!Array.isArray(nodesRaw)) throw new Error('nodes 必须是数组')
    const nodes = nodesRaw.map((item, index) => {
      if (!item || typeof item !== 'object') throw new Error(`nodes[${index}] 无效`)
      const row = item as Record<string, unknown>
      return {
        nodeId: readString(row.nodeId, 'nodeId'),
        nodeRevision: readString(row.nodeRevision, 'nodeRevision'),
        title: readString(row.title, 'title'),
        bodyJson: readString(row.bodyJson, 'bodyJson')
      }
    })
    const membersRaw = value.members
    if (!Array.isArray(membersRaw)) throw new Error('members 必须是数组')
    const members = membersRaw.map((item, index) => {
      if (!item || typeof item !== 'object') throw new Error(`members[${index}] 无效`)
      const row = item as Record<string, unknown>
      return {
        nodeId: readString(row.nodeId, 'nodeId'),
        nodeRevision: readString(row.nodeRevision, 'nodeRevision')
      }
    })
    const edges = parseEdgeList(value.edges, 'edges')
    const sourceReceipts = parseReceiptList(value.sourceReceipts, 'sourceReceipts')
    const nodeSources = parseNodeSourceList(value.nodeSources, 'nodeSources')
    return {
      domain: 'knowledge',
      op: 'publish_version',
      workspaceRoot: readString(value.workspaceRoot, 'workspaceRoot'),
      knowledgeRevision: readString(value.knowledgeRevision, 'knowledgeRevision'),
      parentRevision:
        value.parentRevision === null
          ? null
          : typeof value.parentRevision === 'string'
            ? value.parentRevision.trim()
            : null,
      inputFingerprint: readString(value.inputFingerprint, 'inputFingerprint'),
      expectedCurrentRevision:
        value.expectedCurrentRevision === null
          ? null
          : typeof value.expectedCurrentRevision === 'string'
            ? value.expectedCurrentRevision.trim()
            : null,
      nodes,
      members,
      edges,
      sourceReceipts,
      nodeSources
    }
  }
  if (domain === 'knowledge' && op === 'get_current_revision') {
    return {
      domain: 'knowledge',
      op: 'get_current_revision',
      workspaceRoot: readString(value.workspaceRoot, 'workspaceRoot')
    }
  }
  if (domain === 'knowledge' && op === 'get_tree_projection') {
    return {
      domain: 'knowledge',
      op: 'get_tree_projection',
      workspaceRoot: readString(value.workspaceRoot, 'workspaceRoot')
    }
  }
  if (domain === 'knowledge' && op === 'get_node_material') {
    return {
      domain: 'knowledge',
      op: 'get_node_material',
      workspaceRoot: readString(value.workspaceRoot, 'workspaceRoot'),
      nodeId: readString(value.nodeId, 'nodeId')
    }
  }
  throw new Error(`未知 Worker 命令 ${String(domain)}/${String(op)}`)
}

export function parseLearningDbWorkerResult(raw: unknown): LearningDbWorkerResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Worker 结果无效')
  }
  const value = raw as Record<string, unknown>
  if (value.ok === true) {
    return { ok: true, result: value.result }
  }
  if (value.ok === false && typeof value.message === 'string') {
    return { ok: false, message: value.message }
  }
  throw new Error('Worker 结果无效')
}

export type PersistedCheckpointView = {
  checkpointId: string
  sessionId: string
  runId: string
  cursorVersion: number
  question: string
  rubricJson: string | null
  createdAt: number
  state: string
}

export function receiptFromRaw(raw: unknown): LearningCommandReceipt {
  return parseLearningCommandReceipt(raw)
}

export function normalizeWorkspaceForProject(workspaceRoot: string): string {
  return normalizeWorkspaceRoot(workspaceRoot)
}
