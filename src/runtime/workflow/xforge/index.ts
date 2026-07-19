/**
 * XForge runtime 窄纵切出口：阶段类型、Resolver、Controller 纯函数。
 */

export type {
  XForgeStage,
  XForgeStartStage,
  XForgeTerminalStage,
  ScopePassRef,
  StageResolverInput,
  StageResolverResult,
  StageControllerFacts,
  StageControllerContext,
  StageTransitionResult,
  TransitionBudgetDelta,
  TransitionRejectCode
} from './types'

export {
  XFORGE_TERMINAL_STAGES,
  SCOPE_CORRECTION_BUDGET,
  DELIVERY_TEST_FIX_BUDGET,
  REVIEW_REMEDIATION_BUDGET
} from './types'

export { resolveStartStage, clampStartStage } from './stageResolver'

export {
  isTerminalStage,
  isLegalTransition,
  clampImplementTarget,
  transition,
  nextAfterScopeCheck,
  nextAfterTest,
  nextAfterReview,
  nextAfterFix
} from './stageController'

export type {
  XForgeRunState,
  XForgeStageArtifactRef,
  XForgeEvidenceRef,
  XForgeTaskState,
  XForgeTaskStatus,
  XForgeWorkspaceFingerprint,
  XForgeWriteBoundary,
  XForgeFileEffect,
  XForgeControlledCommandEvidence,
  XForgeTestEvidenceState,
  XForgeReviewFindingState,
  XForgeReportFactsState,
  XForgeMainSessionState,
  XForgeScopeFindingState,
  CreateXForgeRunStateOptions,
  ApplyXForgeTransitionOptions,
  ApplyXForgeTransitionResult
} from './runState'

export {
  createInitialXForgeRunState,
  applyXForgeStageTransition,
  cloneXForgeRunState
} from './runState'

export type {
  XForgePlanTask,
  XForgeValidatedPlan,
  XForgePlanValidation
} from './plan'

export {
  validateXForgePlan,
  createTaskStatesFromPlan
} from './plan'

export type {
  XForgeStageBinding,
  XForgeStageMethod
} from './stageBinding'

export { XForgeRunService, projectRunFromXForge } from './XForgeRunService'
export type {
  CommitXForgeStageResult,
  CommitXForgeStatePatchResult
} from './XForgeRunService'

export type {
  XForgeStageMethodRegistry,
  XForgeStageMethodResolution
} from './stageMethodResolver'

export { resolveXForgeStageMethod } from './stageMethodResolver'

export {
  XFORGE_STAGE_BINDINGS,
  getXForgeStageBinding
} from './stageBinding'

export type {
  XForgeExplorationMethod,
  XForgeScopeFinding,
  XForgeScopeCheckResult,
  XForgeTaskFileEffect,
  XForgeTaskAttemptResult,
  XForgeMainAgentContext,
  XForgeStageHost,
  XForgeStageExecutorOptions
} from './stageExecutor'

export type { XForgeRunCommitter } from './runState'

export {
  XForgeStageExecutor,
  toControllerContext,
  buildWriteBoundary,
  buildMainAgentContext
} from './stageExecutor'

export type {
  XForgeControlledTestCommand,
  XForgeRuntimeCommandResult,
  XForgeReviewInputSnapshot,
  XForgeFixResult,
  XForgeDeliveryHost,
  XForgeDeliveryExecutorOptions
} from './deliveryExecutor'

export {
  XForgeDeliveryExecutor,
  buildReportFacts
} from './deliveryExecutor'

export type {
  XForgePreDeliveryRunner,
  XForgeDeliveryRunner
} from './executionPipeline'

export { XForgeExecutionPipeline } from './executionPipeline'
export {
  runXForgeLiveRuntime
} from './liveRuntime'
export type {
  XForgeLiveRuntimeOptions,
  XForgeLiveRuntimeResult
} from './liveRuntime'
export { classifyXForgeRequest } from './requestResolution'
export { normalizeXForgeBrainstormPayload } from './liveStageHost'
export {
  resolveXForgeTaskVerificationCommand,
  resolveXForgeDeliveryCommands
} from './liveDeliveryHost'
export { XForgeFileEffectRecorder } from './effectRecorder'

export type { XForgeDeliveryRuntimeOptions } from './deliveryRuntime'
export {
  captureXForgeWorkspaceFingerprint,
  parseCommandArgv,
  runXForgeControlledTestCommand,
  resolveXForgeVerificationTimeout,
  recordXForgeTestEvidence,
  createXForgeReviewSnapshot,
  writeXForgeRuntimeReport
} from './deliveryRuntime'

export type {
  XForgeWorkspaceBaselineV1,
  XForgeWorkspaceBaselineEntry,
  XForgeReviewTarget
} from './workspaceBaseline'
export {
  captureXForgeWorkspaceBaseline,
  resolveXForgeReviewTarget,
  listDirtyWorkspaceEntries
} from './workspaceBaseline'

export {
  isPathAllowedByChangeScope,
  normalizeWorkspaceRelativePath
} from './changeScope'

export { buildXForgeReviewSnapshot } from './reviewSnapshot'
export type {
  XForgeReviewSnapshotFile,
  XForgeReviewWorkspaceSnapshot
} from './reviewSnapshot'

export {
  getXForgeRunRoot,
  getXForgeStageDir,
  writeXForgeArtifact,
  writeXForgeEvidence,
  createWorkspaceFingerprint,
  readArtifactText
} from './stageArtifacts'

export type {
  XForgeToolEffect,
  XForgeToolExposureContext,
  XForgeToolAuthorizationContext,
  XForgeToolAuthorizationDecision,
  XForgeVerificationPolicyDecision
} from './policy'
export {
  getXForgeEffectiveToolDefinitions,
  authorizeXForgeToolCall,
  authorizeXForgeVerificationCommand,
  getXForgeToolEffect,
  getVisibleXForgeMainAgentTools,
  getXForgeMainAgentModeInstruction,
  isForbiddenXForgeSideEffectCommand,
  isSafeRuntimeTestCommand
} from './policy'

export type { XForgeEffectInspection } from './writeSafety'
export {
  prepareXForgeWriteBoundary,
  inspectXForgeTaskEffects,
  validateXForgeCommittedEffects
} from './writeSafety'
