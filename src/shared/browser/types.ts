/**
 * 内置浏览器跨 IPC / 工具 / 端口的唯一契约。
 * 逻辑身份与控制世代不可复用；互斥动作必须是判别联合。
 */

export const BROWSER_MAX_LIVE_PAGES = 2 as const

export const BROWSER_PAGE_CAP_MESSAGE = '最多同时两个页面'

/** 每页待执行（尚未开始）命令上限；超限返回 busy。 */
export const BROWSER_PENDING_MAX = 4 as const

/** 截图输出约束；数字是预算，不是建议。 */
export const BROWSER_CAPTURE_DEVICE_SCALE = 1 as const
export const BROWSER_CAPTURE_MAX_LONG_EDGE = 1440 as const
export const BROWSER_CAPTURE_MAX_PIXELS = 2_000_000 as const
export const BROWSER_CAPTURE_MAX_BYTES = 1_048_576 as const
export const BROWSER_CAPTURE_MAX_PER_RUN = 6 as const

export const BROWSER_TOOL_NAMES = Object.freeze([
  'browser_open',
  'browser_observe',
  'browser_act',
  'browser_close',
  'browser_capture'
] as const)

export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number]

export function isBrowserToolName(value: string): value is BrowserToolName {
  return (BROWSER_TOOL_NAMES as readonly string[]).includes(value)
}

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
  'invalid_request',
  'busy'
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
  /** 隔离世界里 window.scrollBy，以 scrollY 真实变化为准 */
  readonly scrollReliable: true
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
  scrollReliable: true
})

export type BrowserControlProjection =
  | { readonly holder: 'none' }
  | { readonly holder: 'user' }
  | { readonly holder: 'agent'; readonly runId: string }

export interface BrowserPageLoadError {
  readonly errorCode: number
  readonly message: string
  readonly url: string
  readonly isCertificateError: boolean
}

/** 页面发起的新窗口、下载或设备权限被拒绝后，交给用户看的一条说明。 */
export interface BrowserGuestNotice {
  readonly kind: 'popup' | 'download' | 'permission'
  readonly sourceUrl: string
  readonly targetUrl: string | null
  readonly message: string
  readonly generation: number
  readonly documentEpoch: number
}

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
  readonly faviconUrl: string | null
  readonly loadError: BrowserPageLoadError | null
  readonly notice: BrowserGuestNotice | null
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
  /** 页面 devicePixelRatio。模拟视口时期望为捕获用的 1。 */
  readonly deviceScaleFactor: number
  /** 当前布局视口来自设备模拟，不是窗口本身的尺寸。 */
  readonly simulated: boolean
  /** 宿主显示器缩放。读不到时为 null，不能写成 1 冒充。 */
  readonly displayScale: number | null
}

export function formatBrowserViewport(viewport: BrowserViewportProjection): string {
  const scale = viewport.displayScale === null ? 'unknown' : String(viewport.displayScale)
  return `${viewport.width}x${viewport.height} ${viewport.device} dpr=${viewport.deviceScaleFactor} simulated=${viewport.simulated ? 'yes' : 'no'} displayScale=${scale}`
}

export interface BrowserRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * 观察受限原因：subframes=iframe 内容未纳入（同源/跨域一致）；
 * node/item/size/time=四类预算截断。
 */
export const BROWSER_OBSERVATION_LIMITS = Object.freeze([
  'subframes',
  'node-budget',
  'item-budget',
  'size-budget',
  'time-budget'
] as const)

export type BrowserObservationLimit = (typeof BROWSER_OBSERVATION_LIMITS)[number]

export function isBrowserObservationLimit(value: string): value is BrowserObservationLimit {
  return (BROWSER_OBSERVATION_LIMITS as readonly string[]).includes(value)
}

/** 两段快照的动作细节段：ref 与 dom 段语义行一一对应 */
export interface BrowserElementDetail {
  readonly ref: string
  readonly role: string
  readonly name: string
  readonly selector: string
  readonly rect: BrowserRect
}

export interface BrowserObservationProjection {
  readonly url: string
  readonly title: string
  readonly viewport: BrowserViewportProjection
  readonly dom: string
  readonly elements: readonly BrowserElementDetail[]
  readonly truncated: boolean
  readonly limits: readonly BrowserObservationLimit[]
  readonly scope?:
    | { readonly kind: 'full' }
    | { readonly kind: 'focused' }
    | { readonly kind: 'full_fallback'; readonly reason: 'missing' | 'ambiguous' | 'unsupported' | 'node-budget' | 'time-budget' | 'incomplete' }
}

export interface BrowserObservationFocus {
  readonly role: string
  readonly name: string
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
  | { readonly kind: 'accept-popup' }
  | { readonly kind: 'dismiss-notice' }

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
  readonly focus?: BrowserObservationFocus
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
      readonly notice: BrowserGuestNotice | null
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
      readonly viewport: BrowserViewportProjection
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

export interface BrowserObserveIpcParams {
  readonly sessionId: string
  readonly browserId: string
}

export interface BrowserActIpcParams {
  readonly sessionId: string
  readonly observation: ObservationIdentity
  readonly action: BrowserAction
}

export interface BrowserCaptureIpcParams {
  readonly sessionId: string
  readonly observation: ObservationIdentity
}

export type BrowserAttachResult =
  | { readonly status: 'applied'; readonly page: BrowserPageProjection }
  | BrowserNotApplied
  | BrowserUnknownOutcome

export interface BrowserGuestMount {
  readonly browserId: string
  readonly generation: number
  readonly sessionId: string
  readonly src: string
  readonly partition: string
  readonly visible: boolean
  /** 模拟视口的 CSS 尺寸。null 表示跟着浏览舞台走。 */
  readonly layoutWidth: number | null
  readonly layoutHeight: number | null
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
