/**
 * 可视化文档装配：快照 HTML 之前注入基础样式与桥脚本。
 *
 * 帧内文档的安全边界由响应头 CSP 承担：内联代码可以执行，但不能联网、嵌套页面、提交表单或改写基址；
 * sandbox 指令保证即使被顶层打开也拿不到宿主源。导出文件没有响应头，改用 meta CSP 保持离线。
 * 预览文档装配的是空壳：作者内容逐段经 postMessage 进入，因此 CSP 只放行带 nonce 的两段装配脚本。
 */
import { randomBytes } from 'crypto'
import {
  parseVisualizationFrameInit,
  parseVisualizationUri,
  VISUALIZATION_MAX_INLINE_HEIGHT,
  type VisualizationAddress,
  type VisualizationTheme
} from '../../shared/visualization'
import { buildVisualizationBridgeScript, type VisualizationBridgeConfig } from './visualizationBridgeScript'
import { buildVisualizationPreviewScript } from './visualizationPreviewScript'
import { VISUALIZATION_BASE_STYLE } from './visualizationStyles'
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
  const config = resolveFrameConfig(url)
  const address = parseVisualizationUri(url)
  if (!address) return buildVisualizationStatusDocument({ ...config, status: 'missing' })
  const snapshot = await reader.read(address)
  return snapshot.status === 'ok'
    ? buildServedVisualizationDocument(snapshot.html, config)
    : buildVisualizationStatusDocument({ ...config, status: snapshot.status })
}

export function buildServedVisualizationDocument(html: string, config: Omit<VisualizationBridgeConfig, 'status'>): string {
  return injectHead(html, `<style>${VISUALIZATION_BASE_STYLE}</style>${bridgeTag({ ...config, status: 'ok' })}`)
}

/** 快照缺失或损坏时同样返回带桥的文档：宿主经 ready 得知状态，无需另行探测 */
export function buildVisualizationStatusDocument(
  config: Omit<VisualizationBridgeConfig, 'status'> & { status: keyof typeof STATUS_TEXT }
): string {
  const text = STATUS_TEXT[config.status]
  return injectHead(`<!doctype html><title>${text}</title><p>${text}</p>`, `<style>${VISUALIZATION_BASE_STYLE}</style>${bridgeTag(config)}`)
}

export function buildExportedVisualizationDocument(html: string, theme: VisualizationTheme): string {
  const head =
    '<meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">` +
    `<style>${VISUALIZATION_BASE_STYLE}</style>` +
    bridgeTag({ status: 'ok', theme, motionScale: 1, maxHeight: VISUALIZATION_MAX_INLINE_HEIGHT })
  return injectHead(html, head)
}

/**
 * 预览外壳：空文档 + 桥脚本 + 预览接收脚本。nonce 每次请求重新生成，
 * CSP 只放行带 nonce 的脚本，推送进来的任何标记都不会获得执行权。
 */
export function resolveVisualizationPreviewDocument(url: string): { document: string; csp: string } {
  const nonce = randomBytes(16).toString('base64')
  const config = resolveFrameConfig(url)
  const document =
    '<!doctype html><meta charset="utf-8">' +
    `<style>${VISUALIZATION_BASE_STYLE}</style>` +
    `<script nonce="${nonce}">${buildVisualizationBridgeScript({ ...config, status: 'ok' })}</script>` +
    `<script nonce="${nonce}">${buildVisualizationPreviewScript()}</script>` +
    '<body></body>'
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    'media-src data: blob:',
    "form-action 'none'",
    "base-uri 'none'",
    'sandbox allow-scripts'
  ].join('; ')
  return { document, csp }
}

function bridgeTag(config: VisualizationBridgeConfig): string {
  return `<script>${buildVisualizationBridgeScript(config)}</script>`
}

/** 主题、慢放倍率与高度上限随帧地址下发；解析不出时与快照帧取同一份默认值 */
function resolveFrameConfig(url: string): Omit<VisualizationBridgeConfig, 'status'> {
  const init = parseVisualizationFrameInit(url)
  return {
    theme: init?.theme ?? null,
    motionScale: init?.motionScale ?? 1,
    maxHeight: init?.maxHeight ?? VISUALIZATION_MAX_INLINE_HEIGHT
  }
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
