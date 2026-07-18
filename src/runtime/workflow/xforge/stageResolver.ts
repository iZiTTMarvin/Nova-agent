/**
 * StageResolver：由结构化信号确定 XForge 安全起点。
 *
 * 优先级（高 → 低）：
 * 1. Review Only
 * 2. Validated Plan / Scope Pass 强制门禁
 * 3. 用户明确起点（仍夹紧）
 * 4. 仓库确定性事实
 * 5. 模型语义补充；失败则保守 brainstorm，禁止静默变 default 闲聊
 */

import type {
  ScopePassRef,
  StageResolverInput,
  StageResolverResult,
  XForgeStartStage
} from './types'

const START_ORDER: readonly XForgeStartStage[] = [
  'brainstorm',
  'plan',
  'scope_check',
  'implement',
  'test',
  'review'
] as const

function isValidScopePass(
  scopePass: ScopePassRef | null | undefined,
  planVersion: number | undefined,
  workspaceRevision: number | undefined
): boolean {
  if (!scopePass) return false
  if (planVersion === undefined || workspaceRevision === undefined) return false
  return (
    scopePass.planVersion === planVersion && scopePass.workspaceRevision === workspaceRevision
  )
}

/**
 * 将候选起点夹紧到满足 Validated Plan / Scope Pass 前置条件的最早合法阶段。
 * review / test 不要求 Validated Plan。
 */
export function clampStartStage(
  candidate: XForgeStartStage,
  input: Pick<
    StageResolverInput,
    'hasValidatedPlan' | 'scopePass' | 'planVersion' | 'workspaceRevision'
  >
): XForgeStartStage {
  const hasPlan = input.hasValidatedPlan === true
  const hasPass = isValidScopePass(input.scopePass, input.planVersion, input.workspaceRevision)

  if (candidate === 'implement') {
    if (!hasPlan) return 'plan'
    if (!hasPass) return 'scope_check'
    return 'implement'
  }

  if (candidate === 'scope_check' && !hasPlan) {
    return 'plan'
  }

  return candidate
}

function skippedBefore(start: XForgeStartStage): XForgeStartStage[] {
  const idx = START_ORDER.indexOf(start)
  if (idx <= 0) return []
  return START_ORDER.slice(0, idx)
}

function skippedAll(): XForgeStartStage[] {
  return [...START_ORDER]
}

interface Candidate {
  stage: XForgeStartStage
  reason: string
  repairPath?: boolean
}

/**
 * 在 Review Only 之外，按确定性信号选出原始候选起点（尚未门禁夹紧）。
 */
function pickCandidate(input: StageResolverInput): Candidate {
  if (input.requestedStartStage) {
    return {
      stage: input.requestedStartStage,
      reason: `用户指定起点 ${input.requestedStartStage}`
    }
  }

  if (input.codeReadyForTest) {
    return {
      stage: 'test',
      reason: '用户声明代码已改完并请求测试/检查'
    }
  }

  // dirty 单独出现不得改入口；此处刻意忽略 workspaceDirty

  if (input.isBugfix) {
    return {
      stage: 'plan',
      reason: '明确 Bug 修复且未声明已完成，走修复计划路径',
      repairPath: true
    }
  }

  const hasPlan = input.hasValidatedPlan === true
  const hasPass = isValidScopePass(input.scopePass, input.planVersion, input.workspaceRevision)

  if (hasPlan && hasPass) {
    return {
      stage: 'implement',
      reason: '存在 Validated Plan 与绑定当前版本的 Scope Pass'
    }
  }

  if (hasPlan) {
    return {
      stage: 'scope_check',
      reason: '存在 Validated Plan 但无有效 Scope Pass'
    }
  }

  if (input.hasDesignOnlyDoc) {
    return {
      stage: 'plan',
      reason: '引用设计文档但无 Validated Plan，先补全实施计划'
    }
  }

  if (input.modelSemanticHint === 'plan') {
    return {
      stage: 'plan',
      reason: '模型语义分类为 plan'
    }
  }

  if (input.modelSemanticHint === 'brainstorm') {
    return {
      stage: 'brainstorm',
      reason: '模型语义分类为 brainstorm'
    }
  }

  if (input.modelSemanticHint === 'failed') {
    // 分类失败：保守 brainstorm；若上文已有设计-only / bugfix 会更早返回
    return {
      stage: 'brainstorm',
      reason: '模型语义分类失败，保守进入 brainstorm'
    }
  }

  if (input.isVagueNewRequirement === true || input.isVagueNewRequirement === undefined) {
    return {
      stage: 'brainstorm',
      reason: '模糊新需求且无 Validated Plan'
    }
  }

  // 禁止静默变 default 闲聊：无可解析信号时仍落在 brainstorm
  return {
    stage: 'brainstorm',
    reason: '缺少可解析起点信号，保守进入 brainstorm'
  }
}

/** 解析 XForge Stage Run 的安全起点 */
export function resolveStartStage(input: StageResolverInput): StageResolverResult {
  if (input.reviewOnly) {
    return {
      startStage: 'review',
      reviewOnly: true,
      skippedStages: skippedBefore('review'),
      reason: 'Review Only 约束优先：只审查且禁止修改'
    }
  }

  if (input.isNonDevRequest) {
    return {
      startStage: 'brainstorm',
      reviewOnly: false,
      skippedStages: skippedAll(),
      reason: '输入不是 XForge 开发交付请求，resolve 阶段直接完成',
      terminalSummary:
        'XForge 面向开发任务的完整流程。这个问题更适合在默认模式下直接问我；如果你想把它变成开发需求，请说明目标、约束和希望改动的范围。'
    }
  }

  const candidate = pickCandidate(input)
  const clamped = clampStartStage(candidate.stage, input)
  const clampedNote =
    clamped !== candidate.stage
      ? `；门禁夹紧 ${candidate.stage} → ${clamped}`
      : ''

  return {
    startStage: clamped,
    reviewOnly: false,
    skippedStages: skippedBefore(clamped),
    reason: `${candidate.reason}${clampedNote}`,
    ...(candidate.repairPath ? { repairPath: true } : {})
  }
}
