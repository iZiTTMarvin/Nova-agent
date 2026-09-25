import type { EvidenceFragment, EvidencePackage } from '../evidence/evidenceTypes'
import type { CompileOutput, CompileOutputNode, CandidateEdge } from '../../build/compileOutputSchema'
import { verifyFragmentAgainstDisk } from '../evidence/WorkspaceEvidencePort'
import { isPathWithinRoot, lexicalNormalize } from '../../../permissions/pathAccess'
import { isAbsolute, join, resolve } from 'node:path'

const PATH_LIKE = /(?:^|[\s"'`])([\w./-]+\.(?:ts|tsx|js|jsx|json|md))(?:[\s"'`:]|$)/g

export type CompileValidationFailure =
  | { code: 'unknown_source_id' }
  | { code: 'tree_cycle' }
  | { code: 'out_of_bounds_path' }
  | { code: 'stale_source' }
  | { code: 'invalid_edge' }
  | { code: 'invalid_parent' }

export type CompileValidationResult =
  | { ok: true; edges: readonly CandidateEdge[]; nodeSources: ReadonlyMap<string, readonly string[]> }
  | { ok: false; failure: CompileValidationFailure; message: string }

function fragmentById(pkg: EvidencePackage): Map<string, EvidenceFragment> {
  return new Map(pkg.fragments.map(f => [f.sourceId, f]))
}

function detectParentCycle(nodes: readonly CompileOutputNode[]): boolean {
  const parent = new Map<string, string | null>()
  for (const n of nodes) parent.set(n.nodeId, n.parentNodeId)
  for (const n of nodes) {
    const seen = new Set<string>()
    let cur: string | null = n.nodeId
    while (cur) {
      if (seen.has(cur)) return true
      seen.add(cur)
      cur = parent.get(cur) ?? null
      if (cur && !parent.has(cur)) break
    }
  }
  return false
}

function scanPathLikeStrings(text: string): string[] {
  const hits: string[] = []
  for (const match of text.matchAll(PATH_LIKE)) {
    if (match[1]) hits.push(match[1])
  }
  return hits
}

function isCitationInsideWorkspace(workspaceRoot: string, rel: string): boolean {
  const normalized = rel.replace(/\\/g, '/')
  if (!normalized || isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) return false
  if (normalized.split('/').includes('..')) return false
  const root = lexicalNormalize(resolve(workspaceRoot))
  const abs = lexicalNormalize(join(root, ...normalized.split('/')))
  return isPathWithinRoot(root, abs)
}

export async function validateCompileCandidate(params: {
  workspaceRoot: string
  evidence: EvidencePackage
  output: CompileOutput
}): Promise<CompileValidationResult> {
  const byId = fragmentById(params.evidence)
  const allowedIds = new Set(byId.keys())
  const nodeIds = new Set(params.output.nodes.map(n => n.nodeId))

  if (detectParentCycle(params.output.nodes)) {
    return { ok: false, failure: { code: 'tree_cycle' }, message: '教学父节点形成环' }
  }

  for (const node of params.output.nodes) {
    if (node.parentNodeId && !nodeIds.has(node.parentNodeId)) {
      return { ok: false, failure: { code: 'invalid_parent' }, message: 'parentNodeId 不存在' }
    }
    for (const claim of node.claims) {
      if (claim.kind === 'source_fact' || claim.kind === 'inference') {
        for (const sourceId of claim.sourceIds) {
          if (!allowedIds.has(sourceId)) {
            return { ok: false, failure: { code: 'unknown_source_id' }, message: '未知 sourceId' }
          }
        }
      }
    }
    const blob = JSON.stringify(node)
    const pathHits = scanPathLikeStrings(blob)
    for (const hit of pathHits) {
      const normalized = hit.replace(/\\/g, '/')
      const inEvidence = params.evidence.fragments.some(
        f => f.relativePath === normalized || f.relativePath.endsWith(`/${normalized}`)
      )
      if (!inEvidence) {
        const ok = isCitationInsideWorkspace(params.workspaceRoot, normalized)
        if (!ok) {
          return { ok: false, failure: { code: 'out_of_bounds_path' }, message: '越界路径引用' }
        }
      }
    }
  }

  for (const fragment of params.evidence.fragments) {
    const used = params.output.nodes.some(n =>
      n.claims.some(
        c =>
          (c.kind === 'source_fact' || c.kind === 'inference') &&
          c.sourceIds.includes(fragment.sourceId)
      )
    )
    if (!used) continue
    const fresh = await verifyFragmentAgainstDisk(params.workspaceRoot, fragment)
    if (!fresh) {
      return { ok: false, failure: { code: 'stale_source' }, message: '出处文件已变化' }
    }
  }

  const edges: CandidateEdge[] = []
  const nodeSources = new Map<string, string[]>()

  for (const node of params.output.nodes) {
    const sources = new Set<string>()
    for (const claim of node.claims) {
      if (claim.kind === 'source_fact' || claim.kind === 'inference') {
        for (const id of claim.sourceIds) sources.add(id)
      }
    }
    nodeSources.set(node.nodeId, [...sources])

    for (const to of node.prerequisiteNodeIds) {
      if (!nodeIds.has(to) || to === node.nodeId) {
        return { ok: false, failure: { code: 'invalid_edge' }, message: 'prerequisite 无效' }
      }
      edges.push({ fromNodeId: node.nodeId, toNodeId: to, edgeKind: 'prerequisite' })
    }
    for (const to of node.relatedNodeIds) {
      if (!nodeIds.has(to) || to === node.nodeId) {
        return { ok: false, failure: { code: 'invalid_edge' }, message: 'related 无效' }
      }
      edges.push({ fromNodeId: node.nodeId, toNodeId: to, edgeKind: 'related' })
    }
    for (const to of node.flowNextNodeIds) {
      if (!nodeIds.has(to) || to === node.nodeId) {
        return { ok: false, failure: { code: 'invalid_edge' }, message: 'flow_next 无效' }
      }
      edges.push({ fromNodeId: node.nodeId, toNodeId: to, edgeKind: 'flow_next' })
    }
  }

  return { ok: true, edges, nodeSources }
}
