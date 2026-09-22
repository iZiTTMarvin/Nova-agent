/**
 * guest debugger 的按需短连接。
 * 空闲后主动 detach；外部 detach（例如 DevTools）后停控，不再抢 attach。
 * 重连必须先重放 Page.enable，以及已经设置过的视口覆盖。
 */
import { browserNotApplied, BROWSER_CAPTURE_DEVICE_SCALE, type BrowserNotApplied } from '../../shared/browser'
import type { BrowserControlFence } from './controlPort'
import type { BrowserGuestDebugger } from './guestContents'

export const BROWSER_CDP_IDLE_MS = 1_500
export const BROWSER_CDP_PROTOCOL = '1.3'

export interface BrowserDeviceMetrics {
  readonly width: number
  readonly height: number
  readonly deviceScaleFactor: typeof BROWSER_CAPTURE_DEVICE_SCALE
  readonly mobile: boolean
  readonly dontSetVisibleSize: true
}

export type CdpSendResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly failure: BrowserNotApplied }

export interface CdpSession {
  send(
    method: string,
    params: Record<string, unknown> | undefined,
    fence: BrowserControlFence,
    deadlineMs: number
  ): Promise<CdpSendResult>
  setDeviceMetrics(metrics: BrowserDeviceMetrics): void
  connectionEpoch(): number
  hasInflight(): boolean
  isExternallyDetached(): boolean
  release(): void
}

export interface CdpSessionOptions {
  readonly idleMs?: number
  readonly schedule?: (fn: () => void, ms: number) => () => void
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms)
  return () => clearTimeout(timer)
}

function fenceDetail(code: BrowserNotApplied['code']): string {
  if (code === 'cancelled') return '命令已取消'
  if (code === 'taken_over') return '页面控制权已变化'
  if (code === 'stale_observation') return '观察已过期'
  if (code === 'page_closed') return '页面已关闭'
  if (code === 'page_crashed') return '页面已崩溃'
  if (code === 'debugger_detached') return '调试会话已断开'
  return '命令已失效'
}

function fenceFailure(fence: BrowserControlFence): BrowserNotApplied | null {
  if (fence.signal?.aborted) return browserNotApplied('cancelled', '命令已取消')
  const current = fence.stillCurrent()
  if (!current.ok) return browserNotApplied(current.code, fenceDetail(current.code))
  return null
}

export function createCdpSession(
  transport: BrowserGuestDebugger,
  options: CdpSessionOptions = {}
): CdpSession {
  const idleMs = options.idleMs ?? BROWSER_CDP_IDLE_MS
  const schedule = options.schedule ?? defaultSchedule
  let metrics: BrowserDeviceMetrics | null = null
  let externallyDetached = false
  let localDetach = false
  let epoch = 0
  let inflight = 0
  let cancelIdle: (() => void) | null = null
  const wakeups = new Set<() => void>()

  const onDetach = (): void => {
    epoch += 1
    if (localDetach) {
      localDetach = false
      return
    }
    externallyDetached = true
    for (const wake of wakeups) wake()
  }
  transport.on('detach', onDetach)

  function clearIdle(): void {
    cancelIdle?.()
    cancelIdle = null
  }

  function detachLocally(): void {
    try {
      if (!transport.isAttached()) return
      localDetach = true
      transport.detach()
    } catch {
      localDetach = false
    }
  }

  function scheduleIdle(): void {
    clearIdle()
    if (inflight > 0 || externallyDetached) return
    cancelIdle = schedule(() => {
      cancelIdle = null
      if (inflight > 0 || externallyDetached) return
      detachLocally()
    }, idleMs)
  }

  async function rawSend(
    method: string,
    params: Record<string, unknown> | undefined,
    fence: BrowserControlFence,
    deadlineMs: number
  ): Promise<CdpSendResult> {
    const blocked = fenceFailure(fence)
    if (blocked) return { ok: false, failure: blocked }
    if (externallyDetached) {
      return { ok: false, failure: browserNotApplied('debugger_detached', '调试会话已断开') }
    }
    if (deadlineMs <= 0) return { ok: false, failure: browserNotApplied('timeout', '命令超过时限') }

    let timer: ReturnType<typeof setTimeout> | undefined
    let wake: (() => void) | undefined
    const guarded = transport.sendCommand(method, params).then(
      (value) => ({ kind: 'value' as const, value }),
      (error: unknown) => ({ kind: 'error' as const, error })
    )
    const raced = await new Promise<
      | { kind: 'value'; value: unknown }
      | { kind: 'error'; error: unknown }
      | { kind: 'timeout' }
      | { kind: 'detach' }
      | { kind: 'stale' }
    >((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), deadlineMs)
      wake = () => resolve({ kind: 'detach' })
      wakeups.add(wake)
      const onAbort = (): void => resolve({ kind: 'stale' })
      fence.signal?.addEventListener('abort', onAbort, { once: true })
      void guarded.then((outcome) => {
        fence.signal?.removeEventListener('abort', onAbort)
        resolve(outcome)
      })
    }).finally(() => {
      if (timer) clearTimeout(timer)
      if (wake) wakeups.delete(wake)
    })

    if (raced.kind === 'timeout') {
      return { ok: false, failure: browserNotApplied('timeout', '命令超过时限') }
    }
    if (raced.kind === 'detach' || externallyDetached) {
      return { ok: false, failure: browserNotApplied('debugger_detached', '调试会话已断开') }
    }
    const stale = fenceFailure(fence)
    if (raced.kind === 'stale' || stale) {
      return { ok: false, failure: stale ?? browserNotApplied('cancelled', '命令已取消') }
    }
    if (raced.kind === 'error') {
      const message = raced.error instanceof Error ? raced.error.message : '调试命令失败'
      if (/destroyed/iu.test(message)) {
        return { ok: false, failure: browserNotApplied('page_closed', '页面已关闭') }
      }
      return { ok: false, failure: browserNotApplied('unavailable', message) }
    }
    return { ok: true, value: raced.value }
  }

  async function ensure(
    fence: BrowserControlFence,
    remaining: () => number
  ): Promise<CdpSendResult | null> {
    if (externallyDetached) {
      return { ok: false, failure: browserNotApplied('debugger_detached', '调试会话已断开') }
    }
    const blocked = fenceFailure(fence)
    if (blocked) return { ok: false, failure: blocked }
    if (transport.isAttached()) return null
    try {
      transport.attach(BROWSER_CDP_PROTOCOL)
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法附着调试会话'
      return { ok: false, failure: browserNotApplied('unavailable', message) }
    }
    if (!transport.isAttached()) {
      return { ok: false, failure: browserNotApplied('debugger_detached', '调试会话已断开') }
    }
    const enabled = await rawSend('Page.enable', undefined, fence, remaining())
    if (!enabled.ok) {
      detachLocally()
      return enabled
    }
    if (!metrics) return null
    const replayed = await rawSend(
      'Emulation.setDeviceMetricsOverride',
      { ...metrics },
      fence,
      remaining()
    )
    if (!replayed.ok) {
      detachLocally()
      return replayed
    }
    return null
  }

  return {
    connectionEpoch: () => epoch,
    hasInflight: () => inflight > 0,
    isExternallyDetached: () => externallyDetached,
    setDeviceMetrics(next) {
      metrics = next
    },
    async send(method, params, fence, deadlineMs) {
      clearIdle()
      inflight += 1
      const started = Date.now()
      const remaining = (): number => Math.max(0, deadlineMs - (Date.now() - started))
      try {
        const ready = await ensure(fence, remaining)
        if (ready) return ready
        return rawSend(method, params, fence, remaining())
      } finally {
        inflight = Math.max(0, inflight - 1)
        if (inflight === 0) scheduleIdle()
      }
    },
    release() {
      clearIdle()
      try {
        transport.off('detach', onDetach)
      } catch {
        // guest 可能已销毁
      }
      detachLocally()
      externallyDetached = false
    }
  }
}
