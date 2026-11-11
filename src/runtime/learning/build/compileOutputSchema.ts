import {
  LEARNING_MAX_COMPILE_OUTPUT_BYTES,
  LEARNING_SKELETON_MAX_INITIAL_NODES
} from '../../../shared/learning/buildLimits'
import { parseKnowledgeClaims } from '../../../shared/learning/knowledgeClaim'
import type { LearningNavDimensionId } from '../../../shared/learning/navigation'
import { LEARNING_NAV_DIMENSIONS } from '../../../shared/learning/navigation'
import type { KnowledgeEdgeKind } from '../../../shared/learning/knowledgeProjection'

export const COMPILE_OUTPUT_SCHEMA_VERSION = 1

export interface CompileOutputNode {
  readonly nodeId: string
  readonly title: string
  readonly summary: string
  readonly learningGoal: string
  readonly navDimension: LearningNavDimensionId | null
  readonly parentNodeId: string | null
  readonly claims: ReturnType<typeof parseKnowledgeClaims>
  readonly prerequisiteNodeIds: readonly string[]
  readonly relatedNodeIds: readonly string[]
  readonly flowNextNodeIds: readonly string[]
}

export interface CompileOutput {
  readonly schemaVersion: number
  readonly nodes: readonly CompileOutputNode[]
}

function readId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 无效`)
  if (value.length > 128) throw new Error(`${field} 过长`)
  return value.trim()
}

function readOptionalId(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return readId(value, 'parentNodeId')
}

function readIdList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是数组`)
  return value.map((item, index) => readId(item, `${field}[${index}]`))
}

function extractCompileJsonText(text: string): string {
  const trimmed = text.trim()
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  const jsonStart = unfenced.indexOf('{')
  const jsonEnd = unfenced.lastIndexOf('}')
  return jsonStart >= 0 && jsonEnd > jsonStart
    ? unfenced.slice(jsonStart, jsonEnd + 1)
    : unfenced
}

export function parseCompileOutputText(text: string): CompileOutput {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > LEARNING_MAX_COMPILE_OUTPUT_BYTES) {
    throw new Error('编译输出超过字节上限')
  }
  let raw: unknown
  const jsonText = extractCompileJsonText(text)
  try {
    raw = JSON.parse(jsonText)
  } catch {
    throw new Error('编译输出不是合法 JSON')
  }
  if (!raw || typeof raw !== 'object') throw new Error('编译输出必须是对象')
  const row = raw as Record<string, unknown>
  const schemaVersion = row.schemaVersion
  if (schemaVersion !== COMPILE_OUTPUT_SCHEMA_VERSION) {
    throw new Error('schemaVersion 不匹配')
  }
  if (!Array.isArray(row.nodes)) throw new Error('nodes 必须是数组')
  if (row.nodes.length > LEARNING_SKELETON_MAX_INITIAL_NODES) {
    throw new Error('节点数超过上限')
  }

  const nodes: CompileOutputNode[] = row.nodes.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`nodes[${index}] 无效`)
    const n = item as Record<string, unknown>
    const nav = n.navDimension
    const navDimension =
      typeof nav === 'string' && (LEARNING_NAV_DIMENSIONS as readonly string[]).includes(nav)
        ? (nav as LearningNavDimensionId)
        : null
    return {
      nodeId: readId(n.nodeId, `nodes[${index}].nodeId`),
      title: readId(n.title, `nodes[${index}].title`),
      summary: typeof n.summary === 'string' ? n.summary : '',
      learningGoal: typeof n.learningGoal === 'string' ? n.learningGoal : '',
      navDimension,
      parentNodeId: readOptionalId(n.parentNodeId),
      claims: parseKnowledgeClaims(n.claims ?? []),
      prerequisiteNodeIds: readIdList(n.prerequisiteNodeIds ?? [], 'prerequisiteNodeIds'),
      relatedNodeIds: readIdList(n.relatedNodeIds ?? [], 'relatedNodeIds'),
      flowNextNodeIds: readIdList(n.flowNextNodeIds ?? [], 'flowNextNodeIds')
    }
  })

  return { schemaVersion: COMPILE_OUTPUT_SCHEMA_VERSION, nodes }
}

export function buildCompileRepairUserMessage(errorMessage: string): string {
  return [
    `上次输出未通过 schema 校验：${errorMessage}。`,
    'claims 字段契约：source_fact 需 { kind, text, sourceIds }（sourceIds 非空）；inference 需 { kind, text, sourceIds, uncertainty }（sourceIds 与 uncertainty 非空）；general_explanation 需 { kind, text }；unverified 需 { kind, question, missingEvidence }。',
    `请直接返回修正后的合法 JSON 对象，不要包裹代码块围栏，schemaVersion=${COMPILE_OUTPUT_SCHEMA_VERSION}。`
  ].join('')
}

export type CandidateEdge = {
  readonly fromNodeId: string
  readonly toNodeId: string
  readonly edgeKind: KnowledgeEdgeKind
}
