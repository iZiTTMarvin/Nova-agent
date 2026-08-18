/**
 * MemoryPolicy 纯函数单测：六种决策路径、晋升门槛、显式优先、scope 纠偏、keyless 等价。
 * 全部用 fake 既有记录；同输入同输出的确定性也在此断言。
 */
import { describe, it, expect } from 'vitest'
import {
  decideMemoryPolicy,
  resolveCandidateScope,
  contentSimilarity
} from '../../../../src/runtime/memory/policy/MemoryPolicy'
import {
  MEMORY_CONFIDENCE_STEP,
  MEMORY_CONTENT_EQUIVALENCE_THRESHOLD
} from '../../../../src/runtime/memory/memoryConfig'
import type {
  MemoryCandidate,
  MemoryPolicyContext,
  MemoryPolicyRelatedRecord,
  MemoryRecord
} from '../../../../src/runtime/memory/types'

const NOW = 1_780_000_000_000
const PROJECT_A = 'aaaaaaaaaaaaaaaa'
const PROJECT_B = 'bbbbbbbbbbbbbbbb'

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem_x',
    scopeKind: 'project',
    scopeId: PROJECT_A,
    kind: 'convention',
    memoryKey: 'commit.style',
    content: 'commit message 使用 feat:/fix: 前缀',
    status: 'active',
    confidence: 0.9,
    explicitness: 'user_explicit',
    sourceType: 'user_message',
    validFrom: NOW,
    validTo: null,
    supersedesId: null,
    evidenceCount: 1,
    distinctSessionCount: 1,
    distinctProjectCount: 1,
    sourcePath: null,
    sourceFingerprint: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastSeenAt: NOW,
    metadata: null,
    ...overrides
  }
}

function related(
  record: MemoryRecord,
  sessions: readonly string[] = [],
  projects: readonly string[] = []
): MemoryPolicyRelatedRecord {
  return {
    record,
    evidenceSessionIds: new Set(sessions),
    evidenceProjectScopeIds: new Set(projects)
  }
}

function makeCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    kind: 'convention',
    scopeHint: 'project',
    memoryKey: 'commit.style',
    content: 'commit message 使用 feat:/fix: 前缀',
    explicitness: 'user_explicit',
    confidence: 0.9,
    intent: 'assert',
    evidence: [{ type: 'user_message', excerpt: '以后 commit 都用 feat:/fix: 风格' }],
    ...overrides
  }
}

function ctx(overrides: Partial<MemoryPolicyContext> = {}): MemoryPolicyContext {
  return {
    now: NOW,
    sessionId: 'sess-1',
    projectScopeId: PROJECT_A,
    relatedRecords: [],
    ...overrides
  }
}

describe('resolveCandidateScope', () => {
  it('scopeHint=global 且 kind=project_fact 强制写入 project scope', () => {
    const scope = resolveCandidateScope(
      makeCandidate({ scopeHint: 'global', kind: 'project_fact' }),
      PROJECT_A
    )
    expect(scope).toEqual({ scopeKind: 'project', scopeId: PROJECT_A })
  })

  it('scopeHint=global 且证据全部为 workspace 文件事实时降为 project', () => {
    const scope = resolveCandidateScope(
      makeCandidate({
        scopeHint: 'global',
        kind: 'preference',
        evidence: [{ type: 'workspace', excerpt: 'package.json 使用 pnpm' }]
      }),
      PROJECT_A
    )
    expect(scope).toEqual({ scopeKind: 'project', scopeId: PROJECT_A })
  })

  it('scopeHint=global 且有用户表态证据的偏好保持 global（不因单项目证据降级）', () => {
    const scope = resolveCandidateScope(
      makeCandidate({
        scopeHint: 'global',
        kind: 'preference',
        memoryKey: 'comment.language',
        evidence: [{ type: 'user_message', excerpt: '我所有项目都用中文注释' }]
      }),
      PROJECT_A
    )
    expect(scope).toEqual({ scopeKind: 'global', scopeId: 'user' })
  })

  it('scopeHint=project 恒为当前项目', () => {
    expect(resolveCandidateScope(makeCandidate(), PROJECT_B)).toEqual({
      scopeKind: 'project',
      scopeId: PROJECT_B
    })
  })
})

describe('ADD', () => {
  it('user_explicit 全局偏好直达 active 且落 global scope', () => {
    const decision = decideMemoryPolicy(
      makeCandidate({
        scopeHint: 'global',
        kind: 'preference',
        memoryKey: 'commit.style'
      }),
      ctx()
    )
    expect(decision).toMatchObject({
      operation: 'ADD',
      reason: 'strong-evidence-active',
      draft: { status: 'active', scope: { scopeKind: 'global', scopeId: 'user' } }
    })
  })

  it('workspace_verified 项目事实直达 active', () => {
    const decision = decideMemoryPolicy(
      makeCandidate({ kind: 'project_fact', explicitness: 'workspace_verified' }),
      ctx()
    )
    expect(decision).toMatchObject({
      operation: 'ADD',
      reason: 'strong-evidence-active',
      draft: { status: 'active' }
    })
  })

  it('observed 首次（project 与 global）一律 pending', () => {
    const projectDecision = decideMemoryPolicy(
      makeCandidate({ explicitness: 'observed', confidence: 0.7 }),
      ctx()
    )
    expect(projectDecision).toMatchObject({
      operation: 'ADD',
      reason: 'observed-pending',
      draft: { status: 'pending' }
    })

    const globalDecision = decideMemoryPolicy(
      makeCandidate({ scopeHint: 'global', kind: 'preference', explicitness: 'observed' }),
      ctx()
    )
    expect(globalDecision).toMatchObject({
      operation: 'ADD',
      reason: 'observed-pending',
      draft: { status: 'pending', scope: { scopeKind: 'global' } }
    })
  })

  it('inferred 低置信直接忽略，达阈值缓行 pending', () => {
    expect(
      decideMemoryPolicy(makeCandidate({ explicitness: 'inferred', confidence: 0.2 }), ctx())
    ).toMatchObject({ operation: 'IGNORE', reason: 'inferred-below-threshold' })
    expect(
      decideMemoryPolicy(makeCandidate({ explicitness: 'inferred', confidence: 0.6 }), ctx())
    ).toMatchObject({ operation: 'ADD', reason: 'inferred-pending', draft: { status: 'pending' } })
  })

  it('无证据候选一律忽略（防御：提炼层应保证非空）', () => {
    const candidate = makeCandidate({ evidence: [] })
    expect(candidate.evidence).toHaveLength(0)
    expect(decideMemoryPolicy(candidate, ctx())).toMatchObject({
      operation: 'IGNORE',
      reason: 'no-evidence'
    })
  })
})

describe('MERGE', () => {
  it('keyed 等价命中：计数去重按 sessionId，同会话重复不计数不晋升', () => {
    const record = makeRecord({
      explicitness: 'observed',
      status: 'pending',
      confidence: 0.5
    })
    const decision = decideMemoryPolicy(
      makeCandidate({ explicitness: 'observed', confidence: 0.5 }),
      ctx({ sessionId: 'sess-1', relatedRecords: [related(record, ['sess-1'])] })
    )
    expect(decision).toMatchObject({
      operation: 'MERGE',
      reason: 'equivalent-merge',
      targetId: 'mem_x',
      distinctSessionCount: 1,
      promote: false
    })
    if (decision.operation === 'MERGE') {
      expect(decision.confidence).toBeCloseTo(0.5 + MEMORY_CONFIDENCE_STEP, 5)
      expect(decision.evidence).toHaveLength(1)
    }
  })

  it('project observed 跨 2 个 session 晋升 active', () => {
    const record = makeRecord({ explicitness: 'observed', status: 'pending', confidence: 0.5 })
    const decision = decideMemoryPolicy(
      makeCandidate({ explicitness: 'observed', confidence: 0.5 }),
      ctx({ sessionId: 'sess-2', relatedRecords: [related(record, ['sess-1'])] })
    )
    expect(decision).toMatchObject({
      operation: 'MERGE',
      reason: 'equivalent-merge-promoted',
      distinctSessionCount: 2,
      promote: true
    })
  })

  it('global observed 跨 2 个 project 晋升；单 project 不晋升', () => {
    const record = makeRecord({
      scopeKind: 'global',
      scopeId: 'user',
      kind: 'preference',
      memoryKey: 'stack.ui',
      content: '用户经常使用 React',
      explicitness: 'observed',
      status: 'pending',
      confidence: 0.5
    })
    const candidate = makeCandidate({
      scopeHint: 'global',
      kind: 'preference',
      memoryKey: 'stack.ui',
      content: '用户经常使用 React',
      explicitness: 'observed',
      confidence: 0.5
    })

    const crossProject = decideMemoryPolicy(
      candidate,
      ctx({ projectScopeId: PROJECT_B, relatedRecords: [related(record, ['sess-1'], [PROJECT_A])] })
    )
    expect(crossProject).toMatchObject({
      operation: 'MERGE',
      distinctProjectCount: 2,
      promote: true
    })

    const sameProject = decideMemoryPolicy(
      candidate,
      ctx({ projectScopeId: PROJECT_A, relatedRecords: [related(record, ['sess-1'], [PROJECT_A])] })
    )
    expect(sameProject).toMatchObject({ operation: 'MERGE', promote: false })
  })

  it('pending observed 记录收到 user_explicit 等价新证据立即晋升', () => {
    const record = makeRecord({
      scopeKind: 'global',
      scopeId: 'user',
      kind: 'preference',
      memoryKey: 'stack.ui',
      content: '用户经常使用 React',
      explicitness: 'observed',
      status: 'pending'
    })
    const decision = decideMemoryPolicy(
      makeCandidate({
        scopeHint: 'global',
        kind: 'preference',
        memoryKey: 'stack.ui',
        content: '用户经常使用 React',
        explicitness: 'user_explicit'
      }),
      ctx({ projectScopeId: PROJECT_A, relatedRecords: [related(record, ['sess-1'], [PROJECT_A])] })
    )
    expect(decision).toMatchObject({ operation: 'MERGE', promote: true })
  })

  it('置信度温和上调且有上限：已达上限保持不变', () => {
    const record = makeRecord({ confidence: 0.95 })
    const decision = decideMemoryPolicy(
      makeCandidate(),
      ctx({ relatedRecords: [related(record, ['sess-1'])] })
    )
    expect(decision).toMatchObject({ operation: 'MERGE', confidence: 0.95 })
  })

  it('keyless 相似内容等价合并，不相似则新增', () => {
    const gotcha = '升级 better-sqlite3 后原生模块编译失败需要 electron-rebuild 重建才能加载'
    const record = makeRecord({
      kind: 'gotcha',
      memoryKey: null,
      content: gotcha,
      explicitness: 'observed'
    })
    const similar = makeCandidate({
      kind: 'gotcha',
      memoryKey: null,
      content: `${gotcha}，Windows 下还需删除 build 缓存`,
      explicitness: 'observed',
      confidence: 0.5
    })
    expect(contentSimilarity(similar.content, gotcha)).toBeGreaterThanOrEqual(
      MEMORY_CONTENT_EQUIVALENCE_THRESHOLD
    )
    expect(
      decideMemoryPolicy(similar, ctx({ relatedRecords: [related(record, ['sess-1'])] }))
    ).toMatchObject({ operation: 'MERGE', targetId: 'mem_x' })

    const unrelated = makeCandidate({
      kind: 'gotcha',
      memoryKey: null,
      content: '大文件读取时流式处理可以避免内存占用过高的问题',
      explicitness: 'observed',
      confidence: 0.5
    })
    expect(
      decideMemoryPolicy(unrelated, ctx({ relatedRecords: [related(record, ['sess-1'])] }))
    ).toMatchObject({ operation: 'ADD' })
  })
})

describe('SUPERSEDE', () => {
  it('同 key 可变事实改写：旧 superseded 语义、新记录 active', () => {
    const old = makeRecord({
      kind: 'project_fact',
      memoryKey: 'database.primary',
      content: '项目主数据库为 SQLite',
      explicitness: 'workspace_verified',
      confidence: 0.8
    })
    const decision = decideMemoryPolicy(
      makeCandidate({
        kind: 'project_fact',
        memoryKey: 'database.primary',
        content: '项目主数据库为 PostgreSQL',
        explicitness: 'workspace_verified',
        confidence: 0.85
      }),
      ctx({ relatedRecords: [related(old)] })
    )
    expect(decision).toMatchObject({
      operation: 'SUPERSEDE',
      reason: 'mutable-fact-superseded',
      targetId: 'mem_x',
      draft: { status: 'active', content: '项目主数据库为 PostgreSQL' }
    })
  })

  it('低 rank 不得改写高 rank：inferred 冲突 explicit 只能缓行 pending', () => {
    const explicit = makeRecord({
      kind: 'preference',
      memoryKey: 'comment.language',
      content: '注释语言使用中文',
      explicitness: 'user_explicit',
      confidence: 0.95
    })
    const decision = decideMemoryPolicy(
      makeCandidate({
        kind: 'preference',
        memoryKey: 'comment.language',
        content: '注释语言使用英文',
        explicitness: 'inferred',
        confidence: 0.9
      }),
      ctx({ relatedRecords: [related(explicit)] })
    )
    expect(decision).toMatchObject({ operation: 'ADD', reason: 'conflict-pending', draft: { status: 'pending' } })
  })

  it('同 rank 但置信度不足同样被拦下', () => {
    const old = makeRecord({
      kind: 'project_fact',
      memoryKey: 'database.primary',
      content: '项目主数据库为 SQLite',
      explicitness: 'workspace_verified',
      confidence: 0.9
    })
    const decision = decideMemoryPolicy(
      makeCandidate({
        kind: 'project_fact',
        memoryKey: 'database.primary',
        content: '项目主数据库为 PostgreSQL',
        explicitness: 'workspace_verified',
        confidence: 0.7
      }),
      ctx({ relatedRecords: [related(old)] })
    )
    expect(decision).toMatchObject({ operation: 'ADD', draft: { status: 'pending' } })
  })

  it('高 rank 可以改写低 rank（current user explicit > workspace verified）', () => {
    const old = makeRecord({
      kind: 'project_fact',
      memoryKey: 'database.primary',
      content: '项目主数据库为 SQLite',
      explicitness: 'workspace_verified',
      confidence: 0.95
    })
    const decision = decideMemoryPolicy(
      makeCandidate({
        kind: 'project_fact',
        memoryKey: 'database.primary',
        content: '项目主数据库为 PostgreSQL',
        explicitness: 'user_explicit',
        confidence: 0.6
      }),
      ctx({ relatedRecords: [related(old)] })
    )
    expect(decision).toMatchObject({ operation: 'SUPERSEDE' })
  })

  it('current workspace verified 可改写 previous user explicit（工作区现状优先于历史表态）', () => {
    const old = makeRecord({
      kind: 'project_fact',
      memoryKey: 'database.primary',
      content: '项目主数据库为 SQLite',
      explicitness: 'user_explicit',
      confidence: 0.95
    })
    const decision = decideMemoryPolicy(
      makeCandidate({
        kind: 'project_fact',
        memoryKey: 'database.primary',
        content: '项目主数据库为 PostgreSQL',
        explicitness: 'workspace_verified',
        confidence: 0.6
      }),
      ctx({ relatedRecords: [related(old)] })
    )
    expect(decision).toMatchObject({
      operation: 'SUPERSEDE',
      reason: 'mutable-fact-superseded',
      targetId: 'mem_x',
      draft: { status: 'active', content: '项目主数据库为 PostgreSQL' }
    })
  })

  it('observed 不得改写 user_explicit：高置信也只能缓行 pending', () => {
    const explicit = makeRecord({
      kind: 'preference',
      memoryKey: 'comment.language',
      content: '注释语言使用中文',
      explicitness: 'user_explicit',
      confidence: 0.9
    })
    const decision = decideMemoryPolicy(
      makeCandidate({
        kind: 'preference',
        memoryKey: 'comment.language',
        content: '注释语言使用英文',
        explicitness: 'observed',
        confidence: 0.95
      }),
      ctx({ relatedRecords: [related(explicit)] })
    )
    expect(decision).toMatchObject({
      operation: 'ADD',
      reason: 'conflict-pending',
      draft: { status: 'pending' }
    })
  })
})

describe('RETRACT（negate 语义）', () => {
  it('negate 命中同 key 既有 active：软删除该记录', () => {
    const record = makeRecord({ content: 'commit message 使用 emoji 风格' })
    const decision = decideMemoryPolicy(
      makeCandidate({
        content: 'commit message 不再使用 emoji 风格',
        intent: 'negate'
      }),
      ctx({ relatedRecords: [related(record)] })
    )
    expect(decision).toMatchObject({
      operation: 'RETRACT',
      reason: 'negate-retract',
      targetId: 'mem_x'
    })
  })

  it('negate 且带新内容：按 SUPERSEDE 处理（仍受 rank 约束）', () => {
    const record = makeRecord({
      content: 'commit message 使用 emoji 风格',
      explicitness: 'user_explicit',
      confidence: 0.8
    })
    const decision = decideMemoryPolicy(
      makeCandidate({
        content: 'commit message 改用 conventional commits 风格',
        intent: 'negate',
        explicitness: 'user_explicit',
        confidence: 0.85
      }),
      ctx({ relatedRecords: [related(record)] })
    )
    expect(decision).toMatchObject({ operation: 'SUPERSEDE', reason: 'negate-replace' })
  })

  it('negate 无命中目标时忽略', () => {
    expect(
      decideMemoryPolicy(makeCandidate({ intent: 'negate' }), ctx())
    ).toMatchObject({ operation: 'IGNORE', reason: 'negate-no-target' })
  })

  it('keyless negate 高相似命中撤回；无相似目标忽略', () => {
    const gotcha = '升级 better-sqlite3 后原生模块编译失败需要 electron-rebuild 重建才能加载'
    const record = makeRecord({
      kind: 'gotcha',
      memoryKey: null,
      content: gotcha,
      explicitness: 'observed'
    })
    expect(
      decideMemoryPolicy(
        makeCandidate({ kind: 'gotcha', memoryKey: null, content: gotcha, intent: 'negate' }),
        ctx({ relatedRecords: [related(record)] })
      )
    ).toMatchObject({ operation: 'RETRACT' })

    expect(
      decideMemoryPolicy(
        makeCandidate({
          kind: 'gotcha',
          memoryKey: null,
          content: '与既有记录毫无相似之处的一条全新经验内容',
          intent: 'negate'
        }),
        ctx({ relatedRecords: [related(record)] })
      )
    ).toMatchObject({ operation: 'IGNORE', reason: 'negate-no-target' })
  })
})

describe('已撤回/已被替代记忆的复活规则', () => {
  it('非 user_explicit 等价候选不得复活已撤回记忆', () => {
    const retracted = makeRecord({ status: 'retracted', content: 'commit message 使用 emoji 风格' })
    expect(
      decideMemoryPolicy(
        makeCandidate({
          content: 'commit message 使用 emoji 风格',
          explicitness: 'observed',
          confidence: 0.8
        }),
        ctx({ relatedRecords: [related(retracted)] })
      )
    ).toMatchObject({ operation: 'IGNORE', reason: 'equivalent-retracted' })
  })

  it('user_explicit 等价重申：新增 active 记录，不复活旧行', () => {
    const retracted = makeRecord({ status: 'retracted', content: 'commit message 使用 emoji 风格' })
    const decision = decideMemoryPolicy(
      makeCandidate({ content: 'commit message 使用 emoji 风格', confidence: 0.95 }),
      ctx({ relatedRecords: [related(retracted)] })
    )
    expect(decision).toMatchObject({
      operation: 'ADD',
      reason: 'strong-evidence-active',
      draft: { status: 'active', content: 'commit message 使用 emoji 风格' }
    })
    expect(decision).not.toHaveProperty('targetId')
  })
})

describe('确定性', () => {
  it('同输入同输出（deep equal）', () => {
    const record = makeRecord({ explicitness: 'observed', status: 'pending' })
    const context = ctx({ relatedRecords: [related(record, ['sess-1'])], sessionId: 'sess-2' })
    const first = decideMemoryPolicy(makeCandidate({ explicitness: 'observed' }), context)
    const second = decideMemoryPolicy(makeCandidate({ explicitness: 'observed' }), context)
    expect(first).toEqual(second)
  })
})
