/**
 * 进程内 BrowserSessionHost 指针。装配写、工具读；本文件不依赖 Electron。
 */
import type { BrowserSessionHost } from './sessionHost'

let host: BrowserSessionHost | null = null

export function setBrowserSessionHost(next: BrowserSessionHost): void {
  host = next
}

export function getBrowserSessionHost(): BrowserSessionHost | null {
  return host
}
