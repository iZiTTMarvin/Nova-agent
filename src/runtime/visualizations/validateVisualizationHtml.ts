/**
 * 可视化发布闸门：快照必须离线自包含。
 *
 * 运行期的响应头 CSP 与帧导航策略才是安全边界；这里在写快照前把注定失效的外联
 * （CDN 脚本、远程图片、联网取数）变成可操作的拒绝原因，避免把白屏产物写进历史。
 * 内联脚本本身不受限：它只在无同源权限的沙箱帧里运行。
 *
 * linkedom 是纯 ESM，主进程 CJS bundle 只能动态 import。
 */
import { MAX_VISUALIZATION_HTML_BYTES } from '../../shared/visualization'

const MAX_REPORTED_VIOLATIONS = 8
const SNIPPET_CHARS = 60

const NESTED_CONTEXT_TAGS = new Set(['iframe', 'frame', 'frameset', 'object', 'embed', 'portal', 'fencedframe'])
/** 这些属性的值会被浏览器当作资源去加载 */
const RESOURCE_ATTRIBUTES = new Set(['src', 'poster', 'background'])
/** a / area 的 href 是用户导航（外链经桥交给宿主打开），其余元素上的 href 是资源引用 */
const NAVIGATION_TAGS = new Set(['a', 'area'])

const CSS_IMPORT_PATTERN = /@import\b/i
const CSS_URL_PATTERN = /url\(\s*['"]?\s*([^'")\s]*)/gi
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*['"`]([^'"`]+)['"`]/g
const STATIC_IMPORT_PATTERN = /(?:^|[;\n}])\s*(?:import|export)\s*(?:[\w*{}\s,$]+?\s*from\s*)?['"]([^'"]+)['"]/g
const NETWORK_CALL_PATTERN =
  /\b(?:fetch|EventSource|WebSocket|sendBeacon)\s*\(\s*['"`]((?:https?|wss?):\/\/[^'"`]*)|\.open\(\s*['"](?:GET|POST|PUT|PATCH|DELETE|HEAD)['"]\s*,\s*['"`]((?:https?:)?\/\/[^'"`]*)/gi

export async function validateVisualizationHtml(html: string): Promise<string[]> {
  if (!html.trim()) return ['html 为空']
  const bytes = Buffer.byteLength(html, 'utf8')
  if (bytes > MAX_VISUALIZATION_HTML_BYTES) {
    return [`体积 ${(bytes / 1024 / 1024).toFixed(2)} MiB，超过 2 MiB 上限`]
  }

  const { parseHTML } = await import('linkedom')
  const { document } = parseHTML(html) as unknown as { document: Document }
  const violations: string[] = []
  const report = (message: string): boolean => {
    if (!violations.includes(message)) violations.push(message)
    return violations.length >= MAX_REPORTED_VIOLATIONS
  }

  for (const element of Array.from(document.querySelectorAll('*'))) {
    if (inspectElement(element, report)) break
  }
  return violations
}

function inspectElement(element: Element, report: (message: string) => boolean): boolean {
  const tag = element.localName.toLowerCase()

  if (NESTED_CONTEXT_TAGS.has(tag)) return report(`<${tag}>：不允许嵌套页面或插件`)
  if (tag === 'base') return report('<base>：不允许改写基准地址')
  if (tag === 'meta' && element.getAttribute('http-equiv')?.trim().toLowerCase() === 'refresh') {
    return report('<meta http-equiv="refresh">：不允许自动跳转')
  }
  if (tag === 'link') {
    const href = element.getAttribute('href') ?? ''
    if (href && !isInlineResource(href)) {
      return report(`<link href="${snippet(href)}">：外部资源不可用，样式请写进 <style>`)
    }
  }
  if (tag === 'form') {
    const action = element.getAttribute('action')?.trim() ?? ''
    if (action && !action.startsWith('#') && !/^javascript:/i.test(action)) {
      return report(`<form action="${snippet(action)}">：不允许提交到外部`)
    }
  }
  if (tag === 'script') {
    const src = element.getAttribute('src')
    if (src !== null) return report(`<script src="${snippet(src)}">：外部脚本不可用，代码需内联（CDN 无法访问）`)
    if (inspectScript(element.textContent ?? '', element.getAttribute('type'), report)) return true
  }
  if (tag === 'style' && inspectCss(element.textContent ?? '', report)) return true

  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase()
    const value = attribute.value.trim()
    if (!value) continue
    if (name === 'style') {
      if (inspectCss(value, report)) return true
      continue
    }
    if (name === 'srcset' || name === 'imagesrcset') {
      const external = parseSrcsetUrls(value).find(url => !isInlineResource(url))
      if (external && report(`<${tag} ${name}="${snippet(external)}">：外部图片不可用，需改为 data: URL`)) return true
      continue
    }
    const isResourceHref = (name === 'href' || name === 'xlink:href') && !NAVIGATION_TAGS.has(tag) && tag !== 'link'
    if ((RESOURCE_ATTRIBUTES.has(name) || isResourceHref) && !isInlineResource(value)) {
      if (report(`<${tag} ${name}="${snippet(value)}">：外部资源不可用，需改为 data: URL`)) return true
      continue
    }
    if (/^data:text\/html/i.test(value) && report(`<${tag} ${name}>：不允许嵌套 HTML 文档`)) return true
  }
  return false
}

function inspectCss(css: string, report: (message: string) => boolean): boolean {
  if (CSS_IMPORT_PATTERN.test(css) && report('CSS @import：外部样式表不可用，需内联')) return true
  for (const match of css.matchAll(CSS_URL_PATTERN)) {
    const url = match[1] ?? ''
    if (url && !isInlineResource(url) && report(`CSS url(${snippet(url)})：外部资源不可用，需改为 data: URL`)) {
      return true
    }
  }
  return false
}

function inspectScript(code: string, type: string | null, report: (message: string) => boolean): boolean {
  const specifiers = [...code.matchAll(DYNAMIC_IMPORT_PATTERN)].map(match => match[1])
  if (type?.trim().toLowerCase() === 'module') {
    specifiers.push(...[...code.matchAll(STATIC_IMPORT_PATTERN)].map(match => match[1]))
  }
  for (const specifier of specifiers) {
    if (specifier && !isInlineResource(specifier)) {
      if (report(`import "${snippet(specifier)}"：外部模块不可用，代码需内联（CDN 无法访问）`)) return true
    }
  }
  for (const match of code.matchAll(NETWORK_CALL_PATTERN)) {
    const url = match[1] ?? match[2] ?? ''
    if (report(`请求 ${snippet(url)}：可视化不能联网，数据需直接写进页面`)) return true
  }
  return false
}

/** srcset 候选以逗号分隔，但 URL 本身（如 data: URL）可含逗号：URL 取到空白为止 */
function parseSrcsetUrls(value: string): string[] {
  const urls: string[] = []
  let index = 0
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index])) index++
    const start = index
    while (index < value.length && !/\s/.test(value[index])) index++
    const raw = value.slice(start, index)
    const url = raw.replace(/,+$/, '')
    if (url) urls.push(url)
    if (url === raw) {
      while (index < value.length && value[index] !== ',') index++
    }
  }
  return urls
}

/** 页面内引用（#id）与内联数据可用；data:text/html 会构成嵌套文档 */
function isInlineResource(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  if (normalized.startsWith('#')) return true
  if (normalized.startsWith('blob:')) return true
  return normalized.startsWith('data:') && !normalized.startsWith('data:text/html')
}

function snippet(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > SNIPPET_CHARS ? `${compact.slice(0, SNIPPET_CHARS)}…` : compact
}
