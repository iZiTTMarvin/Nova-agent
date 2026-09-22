/**
 * Host 调用的页面控制端口。
 * 实现持有 CDP 与隔离世界；Host 仍是页面身份和生命周期的 Owner。
 */
import type {
  BrowserAction,
  BrowserErrorCode,
  BrowserNotApplied,
  BrowserObservationProjection,
  BrowserUnknownOutcome
} from '../../shared/browser'
import type { BrowserGuestContents } from './guestContents'

export interface BrowserControlFence {
  readonly generation: number
  readonly documentEpoch: number
  readonly observationId: string | null
  readonly signal?: AbortSignal
  stillCurrent(): { readonly ok: true } | { readonly ok: false; readonly code: BrowserErrorCode }
}

export interface BrowserDocumentRead {
  readonly snapshot: BrowserObservationProjection
  readonly refs: Readonly<Record<string, string>>
}

export type BrowserControlReadResult =
  | { readonly status: 'applied'; readonly read: BrowserDocumentRead }
  | BrowserNotApplied

export type BrowserControlActResult =
  | { readonly status: 'applied'; readonly summary: string }
  | BrowserNotApplied
  | BrowserUnknownOutcome

export type BrowserControlCaptureResult =
  | {
      readonly status: 'applied'
      readonly width: number
      readonly height: number
      readonly base64: string
    }
  | BrowserNotApplied
  | BrowserUnknownOutcome

export type BrowserControlLoadResult =
  | { readonly status: 'applied' }
  | BrowserNotApplied
  | BrowserUnknownOutcome

export interface BrowserPageControl {
  observe(guest: BrowserGuestContents, fence: BrowserControlFence): Promise<BrowserControlReadResult>
  act(
    guest: BrowserGuestContents,
    fence: BrowserControlFence,
    action: BrowserAction
  ): Promise<BrowserControlActResult>
  capture(guest: BrowserGuestContents, fence: BrowserControlFence): Promise<BrowserControlCaptureResult>
  load(guest: BrowserGuestContents, fence: BrowserControlFence, url: string): Promise<BrowserControlLoadResult>
  bindRefs(observationId: string, refs: Readonly<Record<string, string>>): void
  release(guest: BrowserGuestContents | null): void
}
