import type {
  BrowserActCommand,
  BrowserAuthority,
  BrowserCaptureCommand,
  BrowserCaptureResult,
  BrowserClaimCommand,
  BrowserClaimResult,
  BrowserCloseCommand,
  BrowserCloseResult,
  BrowserListCommand,
  BrowserListResult,
  BrowserNavigateCommand,
  BrowserNavigateResult,
  BrowserObserveCommand,
  BrowserObserveResult,
  BrowserOpenCommand,
  BrowserOpenResult,
  ActionOutcome
} from '../../shared/browser'

export interface BrowserCommandContext {
  readonly sessionId: string
  readonly authority?: BrowserAuthority
  readonly abortSignal?: AbortSignal
}

/**
 * 环境无关的浏览器命令端口。main 注入实现；CLI 可另接非 Electron 实现。
 * 本模块不得依赖 Electron。
 */
export interface BrowserPort {
  open(command: BrowserOpenCommand, context: BrowserCommandContext): Promise<BrowserOpenResult>
  navigate(
    command: BrowserNavigateCommand,
    context: BrowserCommandContext
  ): Promise<BrowserNavigateResult>
  observe(
    command: BrowserObserveCommand,
    context: BrowserCommandContext
  ): Promise<BrowserObserveResult>
  act(command: BrowserActCommand, context: BrowserCommandContext): Promise<ActionOutcome>
  capture(
    command: BrowserCaptureCommand,
    context: BrowserCommandContext
  ): Promise<BrowserCaptureResult>
  close(command: BrowserCloseCommand, context: BrowserCommandContext): Promise<BrowserCloseResult>
  listPages(command: BrowserListCommand, context: BrowserCommandContext): Promise<BrowserListResult>
  claim(command: BrowserClaimCommand, context: BrowserCommandContext): Promise<BrowserClaimResult>
  release(command: BrowserClaimCommand, context: BrowserCommandContext): Promise<BrowserClaimResult>
}

export type { BrowserToolDeps } from './toolSupport'
export {
  buildAuthority,
  failApplied,
  failUnknown,
  formatList,
  formatObservation,
  formatObservationArg,
  formatPage,
  observationParameterSchema,
  parseFail,
  requireBrowserPort,
  resolveBrowserCommandContext,
  unavailablePort
} from './toolSupport'
export {
  captureBudgetOwnerId,
  inspectCaptureBudget,
  releaseCaptureBudget,
  resetCaptureBudgetForTests,
  tryConsumeCaptureBudget
} from './captureBudget'
export { constrainBrowserCapture } from './constrainCapture'
export { probeProviderVision, resetVisionProbeCacheForTests } from './visionProbe'
