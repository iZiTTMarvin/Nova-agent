import { createHash, randomUUID } from 'node:crypto'
import type { ModelClient } from '../../model/ModelClient'
import type { ChatMessage } from '../../model/types'
import { LEARNING_SCHEMA_REPAIR_MAX_EXTRA_CALLS } from '../../../shared/learning/buildLimits'
import { WorkspaceEvidencePort } from '../knowledge/evidence/WorkspaceEvidencePort'
import type { EvidencePackage, LearningCodeIndexQueryPort } from '../knowledge/evidence/evidenceTypes'
import {
  buildCompileRepairUserMessage,
  parseCompileOutputText,
  type CompileOutput
} from './compileOutputSchema'
import { validateCompileCandidate } from '../knowledge/validation/validateCompileCandidate'
import { serializeNodeBody, type PublishedNodeBody } from '../knowledge/nodeBody'
import type { ProjectKnowledge } from '../knowledge/ProjectKnowledgeRepository'
import type { ProjectKnowledgeReader } from '../knowledge/ProjectKnowledgeReader'

export type SkeletonBuildResult =
  | { ok: true; knowledgeRevision: string; modelCallCount: number }
  | {
      ok: false
      reason: string
      modelCallCount: number
      code?: string
    }

function evidencePrompt(evidence: EvidencePackage): string {
  const fragments = evidence.fragments.map(f => ({
    sourceId: f.sourceId,
    path: f.relativePath,
    startLine: f.startLine,
    endLine: f.endLine,
    snippet: f.snippetText
  }))
  return JSON.stringify({
    schemaVersion: 1,
    task: 'skeleton_knowledge_compile',
    evidenceFragments: fragments,
    unreadPaths: evidence.unreadPaths,
    outputContract: {
      schemaVersion: 1,
      nodes: [
        {
          nodeId: 'string',
          title: 'string',
          summary: 'string',
          learningGoal: 'string',
          navDimension: 'key_user_flows | ...',
          parentNodeId: 'string | null',
          claims: [],
          prerequisiteNodeIds: [],
          relatedNodeIds: [],
          flowNextNodeIds: []
        }
      ]
    },
    rules: [
      'source_fact 只能引用 evidence 中的 sourceId',
      '未读文件只能写 unverified 主张',
      '设计原因无文档时用 inference'
    ]
  })
}

async function collectModelText(
  model: ModelClient,
  messages: ChatMessage[]
): Promise<string> {
  let text = ''
  for await (const event of model.chat(messages, [])) {
    if (event.type === 'text_delta') text += event.delta
  }
  return text
}

export class SkeletonKnowledgeBuild {
  private readonly evidencePort: WorkspaceEvidencePort

  constructor(codeIndex: LearningCodeIndexQueryPort | null = null) {
    this.evidencePort = new WorkspaceEvidencePort(codeIndex)
  }

  async run(params: {
    workspaceRoot: string
    modelClient: ModelClient | null
    knowledge: ProjectKnowledge
    reader: ProjectKnowledgeReader
    focusRelativePaths?: readonly string[]
    expectedCurrentRevision?: string | null
  }): Promise<SkeletonBuildResult> {
    if (!params.modelClient) {
      return { ok: false, reason: '无可用模型', modelCallCount: 0 }
    }

    const evidence = await this.evidencePort.collectSkeletonEvidence({
      workspaceRoot: params.workspaceRoot,
      focusRelativePaths: params.focusRelativePaths
    })

    const current =
      params.expectedCurrentRevision !== undefined
        ? params.expectedCurrentRevision
        : await params.reader.getCurrentKnowledgeRevision(params.workspaceRoot)

    let modelCallCount = 0
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: evidencePrompt(evidence)
      }
    ]

    let output: CompileOutput | null = null
    let lastError = 'schema 无效'

    for (let attempt = 0; attempt <= LEARNING_SCHEMA_REPAIR_MAX_EXTRA_CALLS; attempt++) {
      modelCallCount++
      const text = await collectModelText(params.modelClient, messages)
      try {
        output = parseCompileOutputText(text)
        lastError = ''
        break
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e)
        if (attempt >= LEARNING_SCHEMA_REPAIR_MAX_EXTRA_CALLS) break
        messages.push({
          role: 'assistant',
          content: text
        })
        messages.push({
          role: 'user',
          content: buildCompileRepairUserMessage(lastError)
        })
      }
    }

    if (!output) {
      return { ok: false, reason: lastError, modelCallCount, code: 'schema_exhausted' }
    }

    const validation = await validateCompileCandidate({
      workspaceRoot: params.workspaceRoot,
      evidence,
      output
    })
    if (!validation.ok) {
      return {
        ok: false,
        reason: validation.message,
        modelCallCount,
        code: validation.failure.code
      }
    }

    const knowledgeRevision = randomUUID()
    const nodePayloads = output.nodes.map(node => {
      const materialStatus: PublishedNodeBody['materialStatus'] =
        node.claims.some(c => c.kind === 'source_fact') ? 'verified' : 'partial'
      const body: PublishedNodeBody = {
        summary: node.summary,
        learningGoal: node.learningGoal,
        claims: node.claims,
        materialStatus,
        navDimension: node.navDimension,
        parentNodeId: node.parentNodeId,
        unreadNote:
          evidence.unreadPaths.length > 0
            ? `未读路径待核实：${evidence.unreadPaths.slice(0, 8).join(', ')}`
            : undefined
      }
      const nodeRevision = createHash('sha256')
        .update(JSON.stringify(body))
        .digest('hex')
        .slice(0, 32)
      return {
        nodeId: node.nodeId,
        nodeRevision,
        title: node.title,
        bodyJson: serializeNodeBody(body),
        sourceReceiptIds: validation.nodeSources.get(node.nodeId) ?? []
      }
    })

    const sourceReceipts = evidence.fragments
      .filter(f => nodePayloads.some(n => n.sourceReceiptIds.includes(f.sourceId)))
      .map(f => ({
        receiptId: f.sourceId,
        filePath: f.relativePath,
        startLine: f.startLine,
        endLine: f.endLine,
        contentHash: f.contentHash,
        snippetHash: f.snippetHash,
        symbolLabel: f.symbolLabel,
        strategyVersion: f.collectedAt ? evidence.strategyVersion : evidence.strategyVersion,
        collectedAt: f.collectedAt
      }))

    try {
      await params.knowledge.publishVersion({
        workspaceRoot: params.workspaceRoot,
        knowledgeRevision,
        parentRevision: current,
        inputFingerprint: evidence.fingerprint,
        expectedCurrentRevision: current,
        nodes: nodePayloads.map(n => ({
          nodeId: n.nodeId,
          nodeRevision: n.nodeRevision,
          title: n.title,
          bodyJson: n.bodyJson
        })),
        members: nodePayloads.map(n => ({
          nodeId: n.nodeId,
          nodeRevision: n.nodeRevision
        })),
        edges: validation.edges,
        sourceReceipts,
        nodeSources: nodePayloads.flatMap(n =>
          n.sourceReceiptIds.map(receiptId => ({
            nodeId: n.nodeId,
            nodeRevision: n.nodeRevision,
            receiptId
          }))
        )
      })
    } catch (e) {
      return {
        ok: false,
        reason: e instanceof Error ? e.message : String(e),
        modelCallCount
      }
    }

    return { ok: true, knowledgeRevision, modelCallCount }
  }

  collectEvidenceOnly(params: {
    workspaceRoot: string
    focusRelativePaths?: readonly string[]
  }): Promise<EvidencePackage> {
    return this.evidencePort.collectSkeletonEvidence(params)
  }
}
