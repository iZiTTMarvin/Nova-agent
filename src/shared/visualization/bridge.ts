/**
 * 可视化桥协议：宿主与产物帧之间唯一的通道（postMessage）。
 * 沙箱帧没有 allow-same-origin，origin 恒为 opaque：双方只按 event.source 认身份，不校验 origin。
 */
import type { VisualizationTheme } from './contracts'

export const VISUALIZATION_BRIDGE_VERSION = 1
export const MAX_VISUALIZATION_EVENT_NAME_CHARS = 64
export const MAX_VISUALIZATION_EVENT_DATA_CHARS = 4000
export const MAX_VISUALIZATION_ERROR_CHARS = 500
export const MAX_VISUALIZATION_EXTERNAL_URL_CHARS = 2048

/** 快照读取结果：缺失与损坏同样经由帧内文档告知宿主，宿主无需额外探测 */
export type VisualizationDocumentStatus = 'ok' | 'missing' | 'corrupt'

export interface BridgeEnvelope {
  v: typeof VISUALIZATION_BRIDGE_VERSION
  kind: string
  id: string
  seq: number
  payload: unknown
}

/** animated：产物出现了可感知时长的动画，宿主据此才提供慢放 */
export type ArtifactBridgeMessage =
  | { kind: 'ready'; payload: { status: VisualizationDocumentStatus; initialHeight: number } }
  | { kind: 'resize'; payload: { height: number } }
  | { kind: 'event'; payload: { name: string; data: unknown } }
  | { kind: 'error'; payload: { message: string } }
  | { kind: 'open-external'; payload: { url: string } }
  | { kind: 'animated'; payload: Record<string, never> }

export type HostBridgeMessage =
  | { kind: 'ack'; payload: { theme: VisualizationTheme; motionScale: number } }
  | { kind: 'theme-change'; payload: { theme: VisualizationTheme } }
  | { kind: 'motion-scale'; payload: { motionScale: number } }

/** 帧内桥脚本与宿主共用同一事件名规则 */
export const VISUALIZATION_EVENT_NAME_PATTERN = /^[\w.:-]+$/
const DOCUMENT_STATUSES: ReadonlySet<string> = new Set(['ok', 'missing', 'corrupt'])

export function createHostBridgeEnvelope(message: HostBridgeMessage, seq: number): BridgeEnvelope {
  return {
    v: VISUALIZATION_BRIDGE_VERSION,
    kind: message.kind,
    id: `h${seq}`,
    seq,
    payload: message.payload
  }
}

/** 产物发来的消息一律视为不可信输入：信封或载荷任一不合法即丢弃 */
export function parseArtifactBridgeMessage(data: unknown): ArtifactBridgeMessage | null {
  if (!isRecord(data) || data.v !== VISUALIZATION_BRIDGE_VERSION) return null
  if (typeof data.kind !== 'string' || typeof data.id !== 'string' || typeof data.seq !== 'number') return null
  const payload = isRecord(data.payload) ? data.payload : null
  if (!payload) return null

  switch (data.kind) {
    case 'ready': {
      const status = payload.status
      const initialHeight = payload.initialHeight
      if (typeof status !== 'string' || !DOCUMENT_STATUSES.has(status) || !isFiniteNonNegative(initialHeight)) {
        return null
      }
      return {
        kind: 'ready',
        payload: { status: status as VisualizationDocumentStatus, initialHeight }
      }
    }
    case 'resize':
      return isFiniteNonNegative(payload.height) ? { kind: 'resize', payload: { height: payload.height } } : null
    case 'event': {
      const name = payload.name
      if (
        typeof name !== 'string' ||
        name.length === 0 ||
        name.length > MAX_VISUALIZATION_EVENT_NAME_CHARS ||
        !VISUALIZATION_EVENT_NAME_PATTERN.test(name)
      ) {
        return null
      }
      const serialized = serializeEventData(payload.data)
      if (serialized === null) return null
      return { kind: 'event', payload: { name, data: JSON.parse(serialized) as unknown } }
    }
    case 'error': {
      const message = payload.message
      if (typeof message !== 'string' || !message.trim()) return null
      return {
        kind: 'error',
        payload: { message: message.trim().slice(0, MAX_VISUALIZATION_ERROR_CHARS) }
      }
    }
    case 'open-external': {
      const url = typeof payload.url === 'string' ? normalizeExternalUrl(payload.url) : null
      return url ? { kind: 'open-external', payload: { url } } : null
    }
    case 'animated':
      return { kind: 'animated', payload: {} }
    default:
      return null
  }
}

/** 事件数据必须是可 JSON 序列化的小对象：它会成为模型可见的用户消息 */
export function serializeEventData(data: unknown): string | null {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(data ?? null)
  } catch {
    return null
  }
  if (serialized === undefined || serialized.length > MAX_VISUALIZATION_EVENT_DATA_CHARS) return null
  return serialized
}

function normalizeExternalUrl(raw: string): string | null {
  if (raw.length > MAX_VISUALIZATION_EXTERNAL_URL_CHARS) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null
  return url.toString()
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
