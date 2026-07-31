import type { IntegrateResult, WorktreeHandle } from '../../host'
import type { WorkflowPlan } from '../../types'

export interface BrainstormAlternative {
  id: string
  title: string
  approach: string
  tradeoffs: string[]
  risks: string[]
}

export interface BrainstormResult {
  summary: string
  assumptions: string[]
  alternatives: BrainstormAlternative[]
  recommendation: string
  openQuestions: string[]
}

export interface ActivePlanDocument {
  path?: string
  title?: string
  content: string
}

export interface ImplementTaskResult {
  taskId: string
  title: string
  status: 'succeeded' | 'failed'
  summary?: string
  failure?: string
  integration?: IntegrateResult
  worktree?: WorktreeHandle
}

export interface ImplementResult {
  status: 'completed' | 'partial' | 'failed'
  batches: number
  tasks: ImplementTaskResult[]
  succeededTaskIds: string[]
  failedTaskIds: string[]
  fatalReason?: string
}

export interface VerificationCheck {
  name: 'typecheck' | 'test' | 'build'
  command: string
  exitCode: number
  passed: boolean
  evidence: string
}

export interface VerifyResult {
  passed: boolean
  checks: VerificationCheck[]
  failedChecks: Array<'typecheck' | 'test' | 'build'>
}

export type ReviewVerdict = 'pass' | 'conditional' | 'block'

export interface ReviewIssue {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'nit'
  file?: string
  line?: number
  summary: string
  suggestion?: string
}

export interface ReviewResult {
  verdict: ReviewVerdict
  summary: string
  issues: ReviewIssue[]
  strengths: string[]
  recommendations: string[]
  criticalCount: number
  highCount: number
}

export type ReportOutcome = 'completed' | 'completed_with_concerns' | 'blocked'

export interface ReportResult {
  outcome: ReportOutcome
  summary: string
  highlights: string[]
  failures: string[]
  nextSteps: string[]
}

export interface ComposeReportInput {
  request: string
  plan: WorkflowPlan
  brainstorm: BrainstormResult | null
  implement: ImplementResult
  verify: VerifyResult
  review: ReviewResult
}
