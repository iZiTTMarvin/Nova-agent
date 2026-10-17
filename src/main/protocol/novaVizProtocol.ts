/**
 * nova-viz:// 协议：会话内可视化快照的唯一加载入口。
 *
 * 帧文档由主进程装配（桥脚本 + 响应头 CSP）。导航策略保证只有宿主页面能把子帧指向快照，
 * 快照帧及其内部帧不能再导航到任何地址：既不能加载远程页面，也不能读取其他快照。
 * handler 只注册在默认 session 上，内置浏览器的隔离分区访问不到快照。
 */
import {
  protocol,
  type CustomScheme,
  type WebContents,
  type WebContentsWillFrameNavigateEventParams
} from 'electron'
import { VISUALIZATION_SCHEME } from '../../shared/visualization'
import {
  resolveVisualizationDocument,
  VISUALIZATION_RESPONSE_CSP,
  type VisualizationSnapshotReader
} from '../../runtime/visualizations/visualizationDocument'

/** secure：沙箱帧仍是安全上下文；不开 fetch/CORS：帧内脚本不应回读协议 */
export const NOVA_VIZ_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: VISUALIZATION_SCHEME,
  privileges: { standard: true, secure: true }
}

const VISUALIZATION_URL_PREFIX = `${VISUALIZATION_SCHEME}:`

export function registerNovaVizHandler(reader: VisualizationSnapshotReader): void {
  protocol.handle(VISUALIZATION_SCHEME, async (request) => {
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405, statusText: 'Method Not Allowed' })
    }
    const document = await resolveVisualizationDocument(reader, request.url)
    return new Response(document, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': VISUALIZATION_RESPONSE_CSP,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    })
  })
}

export function bindVisualizationFramePolicy(contents: WebContents): void {
  contents.on('will-frame-navigate', (details) => {
    if (!isFrameNavigationAllowed(details, contents.mainFrame.frameTreeNodeId)) {
      details.preventDefault()
    }
  })
}

interface FrameNode {
  readonly url: string
  readonly parent: FrameNode | null
  readonly frameTreeNodeId: number
}

type FrameNavigation = Pick<WebContentsWillFrameNavigateEventParams, 'url' | 'isMainFrame'> & {
  frame: FrameNode | null
  initiator?: FrameNode | null
}

export function isFrameNavigationAllowed(navigation: FrameNavigation, mainFrameTreeNodeId: number): boolean {
  const targetsVisualization = isVisualizationUrl(navigation.url)
  if (navigation.isMainFrame) return !targetsVisualization
  try {
    // 应用自身只有快照帧这一种子帧导航，且其首次导航时帧对象必然存在：缺失即拒绝
    if (!navigation.frame || isWithinVisualization(navigation.frame)) return false
    return !targetsVisualization || navigation.initiator?.frameTreeNodeId === mainFrameTreeNodeId
  } catch {
    // 帧已销毁时读取属性会抛错
    return false
  }
}

function isWithinVisualization(frame: FrameNode): boolean {
  for (let current: FrameNode | null = frame; current?.parent; current = current.parent) {
    if (isVisualizationUrl(current.url)) return true
  }
  return false
}

function isVisualizationUrl(url: string): boolean {
  return url.slice(0, VISUALIZATION_URL_PREFIX.length).toLowerCase() === VISUALIZATION_URL_PREFIX
}
