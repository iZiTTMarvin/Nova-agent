import type { XForgeStage } from './types'

export type XForgeStageMethod =
  | 'br-office-hours'
  | 'br-brainstorming'
  | 'br-task-breakdown'
  | 'br-scope-check'
  | 'main-agent'
  | 'br-debug'
  | 'runtime-test-gate'
  | 'review-subagent'
  | 'runtime-report'

export interface XForgeStageBinding {
  stage: XForgeStage
  method: XForgeStageMethod
  askQuestionRequired?: boolean
  runtimeControlledCommandsOnly?: boolean
  readonlySnapshotOnly?: boolean
}

export const XFORGE_STAGE_BINDINGS: Readonly<Record<XForgeStage, XForgeStageBinding>> = {
  resolve: {
    stage: 'resolve',
    method: 'main-agent'
  },
  brainstorm: {
    stage: 'brainstorm',
    method: 'br-brainstorming',
    askQuestionRequired: true
  },
  plan: {
    stage: 'plan',
    method: 'br-task-breakdown'
  },
  scope_check: {
    stage: 'scope_check',
    method: 'br-scope-check'
  },
  implement: {
    stage: 'implement',
    method: 'main-agent'
  },
  test: {
    stage: 'test',
    method: 'runtime-test-gate',
    runtimeControlledCommandsOnly: true
  },
  review: {
    stage: 'review',
    method: 'review-subagent',
    readonlySnapshotOnly: true
  },
  fix: {
    stage: 'fix',
    method: 'br-debug'
  },
  report: {
    stage: 'report',
    method: 'runtime-report'
  },
  waiting_user: {
    stage: 'waiting_user',
    method: 'main-agent'
  },
  completed: {
    stage: 'completed',
    method: 'main-agent'
  },
  failed: {
    stage: 'failed',
    method: 'main-agent'
  },
  cancelled: {
    stage: 'cancelled',
    method: 'main-agent'
  }
}

export function getXForgeStageBinding(stage: XForgeStage): XForgeStageBinding {
  return XFORGE_STAGE_BINDINGS[stage]
}
