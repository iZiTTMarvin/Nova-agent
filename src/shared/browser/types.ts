/**
 * 内置浏览器跨 IPC / 工具 / 端口的唯一契约。
 * 逻辑身份与控制世代不可复用；互斥动作必须是判别联合。
 */

export const BROWSER_MAX_LIVE_PAGES = 2 as const

export const BROWSER_ERROR_CODES = Object.freeze([
  'unavailable',
  'unsupported',
  'not_owner',
  'taken_over',
  'stale_observation',
  'target_missing',
  'target_ambiguous',
  'target_occluded',
  'navigation_failed',
  'timeout',
  'cancelled',
  'page_closed',
  'page_crashed',
  'debugger_detached',
  'resource_limit',
  'capture_not_ready',
  'budget_exceeded',
  'invalid_request'
] as const)

export type BrowserErrorCode = (typeof BROWSER_ERROR_CODES)[number]

export type BrowserHostKind = 'webview'
export type BrowserEngineKind = 'zcode-inject'
export type BrowserCapturePath = 'guest-capture-page'
export type BrowserViewportDevice = 'desktop' | 'mobile'
export type BrowserScrollDirection = 'up' | 'down'
export type BrowserScrollAmount = 'page' | 'half-page'

export type BrowserLifecycleStatus =
  | 'opening'
  | 'ready'
  | 'hidden'
  | 'failed'
  | 'crashed'
  | 'closing'

export type BrowserControlHolder = 'none' | 'user' | 'agent'

export interface BrowserAuthority {
  readonly sessionId: string
  readonly runId: string
  readonly resourceOwnerRunId: string
  readonly toolCallId: string
}

export interface ObservationIdentity {
  readonly browserId: string
  readonly generation: number
  readonly documentEpoch: number
  readonly observationId: string
}

export interface BrowserPageIdentity {
  readonly browserId: string
  readonly generation: number
  readonly documentEpoch: number
  readonly sessionId: string
  readonly workspaceKey: string
}

export interface BrowserCapabilityDescriptor {
  readonly hostKind: BrowserHostKind
  readonly engineKind: BrowserEngineKind
  readonly isolatedWorld: true
  readonly virtualPaste: true
  readonly capturePath: BrowserCapturePath
  readonly openShadowRoot: true
  /** 同源 iframe 点击尚未有可靠路径，不得当成已支持 */
  readonly sameOriginIframeClicks: false
  readonly crossOriginOopif: false
  /** 滚动真实生效路径未定案，失败不得报成已滚动 */
  readonly scrollReliable: false
}

export const BROWSER_ENGINE_CAPABILITIES: BrowserCapabilityDescriptor = Object.freeze({
  hostKind: 'webview',
  engineKind: 'zcode-inject',
  isolatedWorld: true,
  virtualPaste: true,
  capturePath: 'guest-capture-page',
  openShadowRoot: true,
  sameOriginIframeClicks: false,
  crossOriginOopif: false,
  scrollReliable: false
})

export type BrowserControlProjection =
  | { readonly holder: 'none' }
  | { readonly holder: 'user' }
  | { readonly holder: 'agent'; readonly runId: string }

export interface BrowserPageProjection {
  readonly browserId: string
  readonly generation: number
  readonly documentEpoch: number
  readonly sessionId: string
  readonly url: string
  readonly title: string
  readonly loading: boolean
  readonly lifecycle: BrowserLifecycleStatus
  readonly control: BrowserControlProjection
  readonly capabilities: BrowserCapabilityDescriptor
}

export interface BrowserSurfaceSnapshot {
  readonly sequence: number
  readonly pages: readonly BrowserPageProjection[]
  readonly activeBrowserId: string | null
  readonly maxLivePages: typeof BROWSER_MAX_LIVE_PAGES
}

export interface BrowserViewportProjection {
  readonly width: number
  readonly height: number
  readonly device: BrowserViewportDevice
}

export interface BrowserInteractiveItem {
  readonly ref: string
  readonly role: string
  readonly name: string
}

export interface BrowserObservationProjection {
  readonly url: string
  readonly title: string
  readonly viewport: BrowserViewportProjection
  readonly summary: string
  readonly interactive: readonly BrowserInteractiveItem[]
  readonly truncated: boolean
}

export type BrowserAction =
  | { readonly kind: 'click'; readonly ref: string }
  | { readonly kind: 'fill'; readonly ref: string; readonly text: string }
  | { readonly kind: 'select'; readonly ref: string; readonly values: readonly string[] }
  | { readonly kind: 'press'; readonly ref: string; readonly key: string }
  | {
      readonly kind: 'scroll'
      readonly direction: BrowserScrollDirection
      readonly amount: BrowserScrollAmount
    }
  | {
      readonly kind: 'viewport'
      readonly width: number
      readonly height: number
      readonly device: BrowserViewportDevice
    }

export type BrowserNavigateAction =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'back' }
  | { readonly kind: 'forward' }
  | { readonly kind: 'reload' }
  | { readonly kind: 'stop' }

export interface BrowserNotApplied {
  readonly status: 'not_applied'
  readonly code: BrowserErrorCode
  readonly detail: string
}

export interface BrowserUnknownOutcome {
  readonly status: 'outcome_unknown'
  readonly detail: string
}

export type ActionOutcome =
  | {
      readonly status: 'applied'
      readonly observation: ObservationIdentity
      readonly summary: string
    }
  | BrowserNotApplied
  | BrowserUnknownOutcome

export interface BrowserOpenCommand {
  readonly url: string
}

export interface BrowserNavigateCommand {
  readonly browserId: string
  readonly action: BrowserNavigateAction
}

export interface BrowserObserveCommand {
  readonly browserId: string
}

export interface BrowserActCommand {
  readonly observation: ObservationIdentity
  readonly action: BrowserAction
}

export interface BrowserCaptureCommand {
  readonly observation: ObservationIdentity
}

export interface BrowserCloseCommand {
  readonly browserId: string
}

export interface BrowserListCommand {
  readonly sessionId: string
}

export interface BrowserClaimCommand {
  readonly browserId: string
}

export type BrowserOpenResult =
  | { readonly status: 'applied'; readonly page: BrowserPageProjection }
  | BrowserNotApplied
  | BrowserUnknownOutcome

export type BrowserNavigateResult =
  | { readonly status: 'applied'; readonly page: BrowserPageProjection }
  | BrowserNotApplied
  | BrowserUnknownOutcome

export type BrowserObserveResult =
  | {
      readonly status: 'applied'
      readonly observation: ObservationIdentity
      readonly snapshot: BrowserObservationProjection
    }
  | BrowserNotApplied

export type BrowserCaptureImage = {
  readonly mimeType: 'image/png'
  readonly base64: string
}

export type BrowserCaptureResult =
  | {
      readonly status: 'applied'
      readonly observation: ObservationIdentity
      readonly width: number
      readonly height: number
      readonly capturedAt: number
      readonly image: BrowserCaptureImage
    }
  | BrowserNotApplied
  | BrowserUnknownOutcome

export type BrowserCloseResult =
  | { readonly status: 'applied'; readonly browserId: string }
  | BrowserNotApplied
  | BrowserUnknownOutcome

export type BrowserListResult =
  | { readonly status: 'applied'; readonly snapshot: BrowserSurfaceSnapshot }
  | BrowserNotApplied

export type BrowserClaimResult =
  | { readonly status: 'applied'; readonly page: BrowserPageProjection }
  | BrowserNotApplied
  | BrowserUnknownOutcome

export interface BrowserOpenIpcParams {
  readonly sessionId: string
  readonly url: string
}

export interface BrowserNavigateIpcParams {
  readonly sessionId: string
  readonly browserId: string
  readonly action: BrowserNavigateAction
}

export interface BrowserCloseIpcParams {
  readonly sessionId: string
  readonly browserId: string
}

export interface BrowserSnapshotIpcParams {
  readonly sessionId: string
}

export interface BrowserClaimIpcParams {
  readonly sessionId: string
  readonly browserId: string
}

export interface BrowserAttachIpcParams {
  readonly sessionId: string
  readonly browserId: string
  readonly webContentsId: number
}

export type BrowserAttachResult =
  | { readonly status: 'applied'; readonly page: BrowserPageProjection }
  | BrowserNotApplied
  | BrowserUnknownOutcome

export interface BrowserGuestMount {
  readonly browserId: string
  readonly generation: number
  readonly src: string
  readonly partition: string
  readonly visible: boolean
}

export interface BrowserGuestMountSnapshot {
  readonly sequence: number
  readonly guests: readonly BrowserGuestMount[]
}

export function isBrowserErrorCode(value: string): value is BrowserErrorCode {
  return (BROWSER_ERROR_CODES as readonly string[]).includes(value)
}

export function browserNotApplied(code: BrowserErrorCode, detail: string): BrowserNotApplied {
  return { status: 'not_applied', code, detail }
}
