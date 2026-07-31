/**
 * deep-research workflow 的内部领域契约。
 *
 * 这些形状只在本 workflow 的四个阶段之间流转，不跨 workflow 复用：
 * 调研结论的证据模型（source + confidence）与 compose 审查结论的问题模型
 * （severity + file/line）有各自独立的生命周期与消费者，强行共享会让两条
 * workflow 必须同步修改。
 */

/** brief 阶段拆出的单个子问题；id 同时是 research 阶段的并行任务标识 */
export interface ResearchSubQuestion {
  id: string
  question: string
  /** 为什么这个子问题对主问题必要，供 research 阶段判断搜索方向 */
  rationale?: string
}

export interface ResearchBrief {
  /** 归一化后的主研究问题 */
  question: string
  subQuestions: ResearchSubQuestion[]
  /** 什么条件下算研究完成，review 阶段据此判定 */
  successCriteria: string[]
  outOfScope: string[]
}

/** 单条证据。source 可以是 URL，也可以是工作区内文件路径 */
export interface ResearchEvidence {
  source: string
  excerpt?: string
  confidence: 'high' | 'medium' | 'low'
}

export interface ResearchFinding {
  subQuestionId: string
  question: string
  /**
   * answered：有答案且有证据；inconclusive：搜到东西但不足以回答；
   * failed：子 agent 未产出可用结构化结果（含取消与超时）。
   * 三态分开是为了让 review 阶段能区分"证据不足"和"根本没跑成"。
   */
  status: 'answered' | 'inconclusive' | 'failed'
  answer?: string
  evidence: ResearchEvidence[]
  gaps: string[]
  failure?: string
}

export interface ResearchFindings {
  findings: ResearchFinding[]
  answeredIds: string[]
  inconclusiveIds: string[]
  failedIds: string[]
}

export interface ResearchSynthesis {
  conclusion: string
  keyPoints: string[]
  /** 不同来源相互矛盾之处；必须显式暴露而不是择一采信 */
  conflicts: string[]
  unresolved: string[]
  recommendations: string[]
  /** 结论引用到的来源集合，供 review 阶段核对 */
  citations: string[]
}

export type ResearchReviewVerdict = 'pass' | 'conditional' | 'block'

export interface ResearchReviewIssue {
  severity: 'critical' | 'high' | 'medium' | 'low'
  summary: string
  suggestion?: string
}

export interface ResearchReviewResult {
  verdict: ResearchReviewVerdict
  summary: string
  issues: ResearchReviewIssue[]
  /** 未被任何 finding 覆盖的子问题 id */
  missingSubQuestionIds: string[]
  /** 缺少证据支撑的结论表述 */
  unsupportedClaims: string[]
}

/** workflow 的最终产出结构，作为 WorkflowResult.result 返回给调用方 */
export interface DeepResearchOutcome {
  brief: ResearchBrief
  findings: ResearchFindings
  synthesis: ResearchSynthesis
  review: ResearchReviewResult
}
