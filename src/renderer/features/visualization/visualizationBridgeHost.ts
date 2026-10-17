/**
 * 宿主侧桥端点：所有可视化帧共用一个 message 监听，按 event.source 分发给各自的帧宿主。
 * 沙箱帧 origin 恒为 opaque，帧身份只能由其窗口判定；每次按 iframe 当前的 contentWindow 比对，
 * 帧被浏览器重建（如节点移动）后仍能对上。
 */
import {
  createHostBridgeEnvelope,
  parseArtifactBridgeMessage,
  type ArtifactBridgeMessage,
  type HostBridgeMessage
} from '../../../shared/visualization'

type ArtifactListener = (message: ArtifactBridgeMessage) => void

const frames = new Map<HTMLIFrameElement, ArtifactListener>()

function dispatch(event: MessageEvent): void {
  if (!event.source) return
  for (const [frame, listener] of frames) {
    if (frame.contentWindow !== event.source) continue
    const message = parseArtifactBridgeMessage(event.data)
    if (message) listener(message)
    return
  }
}

export function connectVisualizationFrame(frame: HTMLIFrameElement, listener: ArtifactListener): () => void {
  if (frames.size === 0) window.addEventListener('message', dispatch)
  frames.set(frame, listener)
  return () => {
    if (frames.get(frame) !== listener) return
    frames.delete(frame)
    if (frames.size === 0) window.removeEventListener('message', dispatch)
  }
}

export function createVisualizationFramePoster(frame: HTMLIFrameElement): (message: HostBridgeMessage) => void {
  let seq = 0
  return message => {
    seq += 1
    frame.contentWindow?.postMessage(createHostBridgeEnvelope(message, seq), '*')
  }
}

const USER_INTENT_INTERVAL_MS = 1000

/**
 * 产物发起的回传与外链必须对应一次真实的用户操作：焦点在该帧内且页面处于瞬时激活期。
 * 激活状态由浏览器跨进程同步到祖先帧，产物脚本无法伪造；间隔限制挡住单次操作内的连发。
 */
export function createUserIntentGate(frame: HTMLIFrameElement): () => boolean {
  let lastAcceptedAt = -Infinity
  return () => {
    if (document.activeElement !== frame || navigator.userActivation?.isActive !== true) return false
    const now = performance.now()
    if (now - lastAcceptedAt < USER_INTENT_INTERVAL_MS) return false
    lastAcceptedAt = now
    return true
  }
}
