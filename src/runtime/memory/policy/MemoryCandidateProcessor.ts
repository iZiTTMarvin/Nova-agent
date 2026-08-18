/**
 * MemoryCandidateProcessor — 候选 → 查询等价族 → policy 决策 → 仓储落库的编排者。
 * 策略判断全部来自 MemoryPolicy，本层只做查询、执行与计数；单条候选失败 fail-soft，
 * 不影响同批其余候选，也不向上抛出（宿主日志只输出计数，不含正文）。
 */
import { randomUUID } from 'node:crypto'
import { MEMORY_KEYLESS_RECALL_LIMIT } from '../memoryConfig'
import type {
  MemoryCandidate,
  MemoryPolicyDecision,
  MemoryPolicyRecordDraft,
  MemoryPolicyRelatedRecord
} from '../types'
import type {
  MemoryEvidenceDraft,
  MemoryRecordDraft,
  MemoryRepository
} from '../repository/MemoryRepository'
import {
  computeMemorySourceFingerprint,
  type MemorySourceFingerprintFn
} from '../lifecycle/MemorySourceBinding'
import { decideMemoryPolicy, resolveCandidateScope } from './MemoryPolicy'

export interface MemoryCandidateProcessInput {
  sessionId: string
  projectScopeId: string
  workspaceRoot?: string | null
  candidates: readonly MemoryCandidate[]
}

/** 供宿主日志的计数汇总；不含任何记忆正文 */
export interface MemoryCandidateProcessCounts {
  candidates: number
  added: number
  merged: number
  promoted: number
  superseded: number
  retracted: number
  ignored: number
  failed: number
}

export interface MemoryCandidateProcessorDeps {
  repository: MemoryRepository
  /** 时间源（ms）；测试注入固定时钟 */
  now?: () => number
  /** 记录 id 生成器；测试注入确定性序列 */
  generateRecordId?: () => string
  /** 文件来源指纹；测试注入 fake，默认读取工作区内真实文件 stat */
  sourceFingerprint?: MemorySourceFingerprintFn
}

/** 每个候选最多带多少等价族记录进入 policy（防退化库拖慢提炼） */
const FAMILY_ENRICH_LIMIT = 8

export class MemoryCandidateProcessor {
  private readonly nowFn: () => number
  private readonly generateRecordIdFn: () => string
  private readonly sourceFingerprintFn: MemorySourceFingerprintFn

  constructor(private readonly deps: MemoryCandidateProcessorDeps) {
    this.nowFn = deps.now ?? Date.now
    this.generateRecordIdFn = deps.generateRecordId ?? (() => `mem_${randomUUID()}`)
    this.sourceFingerprintFn = deps.sourceFingerprint ?? computeMemorySourceFingerprint
  }

  process(input: MemoryCandidateProcessInput): MemoryCandidateProcessCounts {
    const counts: MemoryCandidateProcessCounts = {
      candidates: input.candidates.length,
      added: 0,
      merged: 0,
      promoted: 0,
      superseded: 0,
      retracted: 0,
      ignored: 0,
      failed: 0
    }

    for (const candidate of input.candidates) {
      try {
        const decision = decideMemoryPolicy(candidate, {
          now: this.nowFn(),
          sessionId: input.sessionId,
          projectScopeId: input.projectScopeId,
          relatedRecords: this.loadRelatedRecords(candidate, input.projectScopeId)
        })
        this.execute(decision, input, counts)
      } catch {
        counts.failed += 1
      }
    }
    return counts
  }

  private loadRelatedRecords(
    candidate: MemoryCandidate,
    projectScopeId: string
  ): MemoryPolicyRelatedRecord[] {
    const scope = resolveCandidateScope(candidate, projectScopeId)
    const repo = this.deps.repository

    // keyless 等价族不走 FTS：trigram MATCH 是隐式 AND，整段内容查询会漏掉
    // 子集/超集形态的重复记录；改为 scope+kind 内有界直查，等价判定交给 policy 相似度。
    const records = repo
      .listByScope(scope, {
        kind: candidate.kind,
        limit: candidate.memoryKey === null ? MEMORY_KEYLESS_RECALL_LIMIT : undefined
      })
      .filter((record) =>
        candidate.memoryKey === null ? record.memoryKey === null : record.memoryKey === candidate.memoryKey
      )

    return records.slice(0, FAMILY_ENRICH_LIMIT).map((record) => {
      const sessions = new Set<string>()
      const projects = new Set<string>()
      for (const evidence of repo.listEvidence(record.id)) {
        if (evidence.sessionId) {
          sessions.add(evidence.sessionId)
        }
        if (evidence.projectScopeId) {
          projects.add(evidence.projectScopeId)
        }
      }
      return { record, evidenceSessionIds: sessions, evidenceProjectScopeIds: projects }
    })
  }

  private execute(
    decision: MemoryPolicyDecision,
    input: MemoryCandidateProcessInput,
    counts: MemoryCandidateProcessCounts
  ): void {
    const repo = this.deps.repository
    switch (decision.operation) {
      case 'ADD': {
        repo.insertRecord(this.buildRecordDraft(decision.draft, input))
        counts.added += 1
        return
      }
      case 'MERGE': {
        repo.mergeEvidence(decision.targetId, {
          evidence: decision.evidence.map((evidence) => this.toEvidenceDraft(evidence, input)),
          confidence: decision.confidence,
          distinctSessionCount: decision.distinctSessionCount,
          distinctProjectCount: decision.distinctProjectCount,
          lastSeenAt: this.nowFn()
        })
        if (decision.promote) {
          repo.updateStatus(decision.targetId, 'active')
        }
        counts.merged += 1
        if (decision.promote) {
          counts.promoted += 1
        }
        return
      }
      case 'SUPERSEDE': {
        const newId = this.generateRecordIdFn()
        repo.supersedeWithInsert(
          decision.targetId,
          this.buildRecordDraft(decision.draft, input, newId)
        )
        counts.superseded += 1
        return
      }
      case 'RETRACT': {
        repo.retract(decision.targetId)
        counts.retracted += 1
        return
      }
      case 'IGNORE': {
        counts.ignored += 1
      }
    }
  }

  private buildRecordDraft(
    draft: MemoryPolicyRecordDraft,
    input: MemoryCandidateProcessInput,
    id?: string
  ): MemoryRecordDraft {
    return {
      id: id ?? this.generateRecordIdFn(),
      scope: draft.scope,
      kind: draft.kind,
      memoryKey: draft.memoryKey,
      content: draft.content,
      status: draft.status,
      confidence: draft.confidence,
      explicitness: draft.explicitness,
      sourceType: draft.sourceType,
      sourcePath: draft.sourcePath,
      sourceFingerprint: this.resolveSourceFingerprint(draft, input),
      evidence: draft.evidence.map((evidence) => this.toEvidenceDraft(evidence, input))
    }
  }

  private resolveSourceFingerprint(
    draft: MemoryPolicyRecordDraft,
    input: MemoryCandidateProcessInput
  ): string | null {
    if (
      !input.workspaceRoot ||
      !draft.sourcePath ||
      draft.kind !== 'project_fact' ||
      draft.scope.scopeKind !== 'project' ||
      draft.explicitness !== 'workspace_verified'
    ) {
      return null
    }
    const sourcePath = draft.sourcePath
    const hasWorkspaceEvidence = draft.evidence.some(
      (evidence) => evidence.type === 'workspace' && evidence.sourcePath === sourcePath
    )
    if (!hasWorkspaceEvidence) {
      return null
    }
    return this.sourceFingerprintFn(input.workspaceRoot, sourcePath)
  }

  /** 证据行的项目归属是「证据发生时所在项目」，与记录最终落在 project/global scope 无关 */
  private toEvidenceDraft(
    evidence: MemoryPolicyRecordDraft['evidence'][number],
    input: MemoryCandidateProcessInput
  ): MemoryEvidenceDraft {
    return {
      sessionId: evidence.sessionId ?? input.sessionId,
      messageId: evidence.messageId ?? null,
      projectScopeId: input.projectScopeId,
      evidenceType: evidence.type,
      excerpt: evidence.excerpt
    }
  }
}
