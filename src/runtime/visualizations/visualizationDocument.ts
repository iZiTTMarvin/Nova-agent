/**
 * 可视化文档装配：快照 HTML 之前注入基础样式与桥脚本。
 *
 * 帧内文档的安全边界由响应头 CSP 承担：内联代码可以执行，但不能联网、嵌套页面、提交表单或改写基址；
 * sandbox 指令保证即使被顶层打开也拿不到宿主源。导出文件没有响应头，改用 meta CSP 保持离线。
 */
import {
  parseVisualizationFrameInit,
  parseVisualizationUri,
  VISUALIZATION_MAX_INLINE_HEIGHT,
  type VisualizationAddress,
  type VisualizationTheme
} from '../../shared/visualization'
import { buildVisualizationBridgeScript, type VisualizationBridgeConfig } from './visualizationBridgeScript'
import type { VisualizationSnapshotRead } from './VisualizationStore'

const CONTENT_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  'connect-src data: blob:',
  'worker-src blob:',
  "form-action 'none'",
  "base-uri 'none'"
]

export const VISUALIZATION_RESPONSE_CSP = [...CONTENT_POLICY, 'sandbox allow-scripts'].join('; ')
const EXPORT_CSP = CONTENT_POLICY.join('; ')

/** 零特异性：作者任意选择器都能覆盖 */
const BASE_STYLE =
  ':where(html){background:var(--viz-bg,Canvas);color:var(--viz-fg,CanvasText);' +
  'font-family:var(--viz-font-sans,system-ui,sans-serif);line-height:1.5}' +
  ':where(body){margin:0;padding:16px}'

const DOCTYPE_PATTERN = /^\s*<!doctype[^>]*>/i

const STATUS_TEXT = {
  missing: '可视化快照不存在',
  corrupt: '可视化快照已损坏'
} as const

export interface VisualizationSnapshotReader {
  read(address: VisualizationAddress): Promise<VisualizationSnapshotRead>
}

/** 帧请求地址 → 帧内文档；地址非法按快照缺失回应 */
export async function resolveVisualizationDocument(reader: VisualizationSnapshotReader, url: string): Promise<string> {
  const init = parseVisualizationFrameInit(url)
  const config = {
    theme: init?.theme ?? null,
    motionScale: init?.motionScale ?? 1,
    maxHeight: init?.maxHeight ?? VISUALIZATION_MAX_INLINE_HEIGHT
  }
  const address = parseVisualizationUri(url)
  if (!address) return buildVisualizationStatusDocument({ ...config, status: 'missing' })
  const snapshot = await reader.read(address)
  return snapshot.status === 'ok'
    ? buildServedVisualizationDocument(snapshot.html, config)
    : buildVisualizationStatusDocument({ ...config, status: snapshot.status })
}

export function buildServedVisualizationDocument(html: string, config: Omit<VisualizationBridgeConfig, 'status'>): string {
  return injectHead(html, `<style>${BASE_STYLE}</style>${bridgeTag({ ...config, status: 'ok' })}`)
}

/** 快照缺失或损坏时同样返回带桥的文档：宿主经 ready 得知状态，无需另行探测 */
export function buildVisualizationStatusDocument(
  config: Omit<VisualizationBridgeConfig, 'status'> & { status: keyof typeof STATUS_TEXT }
): string {
  const text = STATUS_TEXT[config.status]
  return injectHead(`<!doctype html><title>${text}</title><p>${text}</p>`, `<style>${BASE_STYLE}</style>${bridgeTag(config)}`)
}

export function buildExportedVisualizationDocument(html: string, theme: VisualizationTheme): string {
  const head =
    '<meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">` +
    `<style>${BASE_STYLE}</style>` +
    bridgeTag({ status: 'ok', theme, motionScale: 1, maxHeight: VISUALIZATION_MAX_INLINE_HEIGHT })
  return injectHead(html, head)
}

function bridgeTag(config: VisualizationBridgeConfig): string {
  return `<script>${buildVisualizationBridgeScript(config)}</script>`
}

/**
 * 注入点紧跟 doctype：解析器在此隐式创建 head，作者随后的 <html> 属性仍会合并到根元素上。
 * 缺 doctype 时补上，避免怪异模式改变布局与高度测量。
 */
function injectHead(html: string, head: string): string {
  const source = html.startsWith('\uFEFF') ? html.slice(1) : html
  const doctype = DOCTYPE_PATTERN.exec(source)
  if (!doctype) return `<!doctype html>${head}${source}`
  const end = doctype[0].length
  return `${source.slice(0, end)}${head}${source.slice(end)}`
}
