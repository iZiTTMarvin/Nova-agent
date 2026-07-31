/**
 * code-review workflow 的内部领域契约。
 *
 * 与 compose 的 ReviewResult 形状相近但不共享：compose 的审查结论是 report 阶段的输入，
 * 依附于 plan / implement / verify 的产出；这里的审查结论是直接交付给用户的终态，
 * 依附于 git 变更面（CodeReviewScope）。两者消费者与生命周期不同，
 * 共享一个类型会让两条 workflow 必须同步修改。
 */

/** 审查范围的来源。工作区有未提交改动时优先审查它，否则回退到最近一次提交 */
export type CodeReviewOrigin = 'working-tree' | 'last-commit'

export interface CodeReviewScope {
  origin: CodeReviewOrigin
  /** diff 的基线 ref，写入提示词供 agent 自行复查 */
  baseRef: string
  /** 相对工作区根的变更文件路径 */
  changedFiles: string[]
  /** 未跟踪文件：不在 diff 里，但属于本次改动，必须让 agent 知道要单独读 */
  untrackedFiles: string[]
  diffStat: string
  diff: string
  /** diff 超长被截断；agent 需要用只读工具补读完整文件 */
  truncated: boolean
}

export type CodeReviewVerdict = 'pass' | 'conditional' | 'block'

export type CodeReviewSeverity = 'critical' | 'high' | 'medium' | 'low' | 'nit'

export interface CodeReviewFinding {
  severity: CodeReviewSeverity
  file?: string
  line?: number
  summary: string
  suggestion?: string
}

export interface CodeReviewResult {
  verdict: CodeReviewVerdict
  summary: string
  findings: CodeReviewFinding[]
  strengths: string[]
  /** 审查过程中无法验证、需要人工确认的点 */
  unverified: string[]
  criticalCount: number
  highCount: number
}

export interface CodeReviewOutcome {
  scope: CodeReviewScope
  review: CodeReviewResult
}
