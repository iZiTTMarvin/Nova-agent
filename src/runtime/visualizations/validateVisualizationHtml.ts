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

/** CSS 规则块：选择器 + 声明 */
const CSS_RULE_PATTERN = /([^{}]+)\{([^{}]*)\}/g
/** 根元素的复合选择器：:root / html / body，可带类、属性或伪类（html.dark、:root[data-theme]） */
const ROOT_COMPOUND_PATTERN = /^(?::root|html|body)(?:[.#[:]\S*)?$/i
const CSS_COMBINATOR_PATTERN = /\s*[>+~]\s*|\s+/
/** 颜色字面量：十六进制、颜色函数与常见颜色关键字 */
const COLOR_LITERAL_PATTERN =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(|\b(?:white|black|red|green|blue|gray|grey|orange|yellow|purple|pink|cyan|magenta|silver|navy|teal|olive|maroon|lime|aqua|fuchsia)\b/i
const PALETTE_HINT =
  '颜色写死不会跟随深浅色主题，请删掉这里的颜色，改用 var(--viz-bg)、var(--viz-surface)、var(--viz-fg)、var(--viz-muted)、var(--viz-border)、var(--viz-accent)、var(--viz-series-1..6)'

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
  if (violations.length < MAX_REPORTED_VIOLATIONS) {
    inspectVisualizationStructure(document, html, report)
  }
  return violations
}

const MAX_FLAT_STEP_BUTTONS = 8
const SCRIPT_STEP_ITEM_PATTERN = /\{\s*(?:['"]?(?:id|step|index|num|phase|stage|title|label|name)['"]?\s*:)/g
const STRUCTURED_STAGE_PATTERN = /<svg\b|<canvas\b|<table\b|viz-phases\b|viz-lanes\b|viz-lane\b/i

/**
 * 结构与布局反模式闸门：拦截把长链路平铺成单排微型按钮条或无图形画布的纯文字翻页器。
 */
function inspectVisualizationStructure(
  document: Document,
  rawHtml: string,
  report: (message: string) => boolean
): boolean {
  for (const container of Array.from(document.querySelectorAll('div, nav, header, section, ul, ol'))) {
    const className = container.getAttribute('class') ?? ''
    if (/\b(?:viz-lane-nodes|viz-phases|viz-grid)\b/.test(className)) continue
    const children = Array.from(container.children)
    const tabButtons = children.filter(child => {
      const tag = child.localName.toLowerCase()
      if (tag === 'button') return true
      if (child.getAttribute('role') === 'tab') return true
      return (tag === 'li' || tag === 'span') && child.children.length === 1 && child.children[0]?.localName.toLowerCase() === 'button'
    })
    if (tabButtons.length > MAX_FLAT_STEP_BUTTONS) {
      return report(
        `步骤或标签平铺过多（同一容器内连续排列了 ${tabButtons.length} 个切换按钮）：超过 ${MAX_FLAT_STEP_BUTTONS} 个步骤时禁止塞进单排胶囊条，请拆分为 3–5 个宏观阶段（.viz-phases）并配合泳道/架构画布（<svg> 或 .viz-lanes）+ 右侧详情检视器（.viz-split / .viz-inspector）展示`
      )
    }
  }

  if (!STRUCTURED_STAGE_PATTERN.test(rawHtml)) {
    for (const script of Array.from(document.querySelectorAll('script'))) {
      const code = script.textContent ?? ''
      const matches = code.match(SCRIPT_STEP_ITEM_PATTERN)
      if (matches && matches.length > MAX_FLAT_STEP_BUTTONS) {
        return report(
          `多步骤可视化缺少阶段分组与图形画布（脚本定义了 ${matches.length} 个步骤项，但页面没有 <svg>、.viz-phases 或 .viz-lanes 泳道图）：禁止只渲染步骤胶囊条配文字卡片，请使用 3–5 个宏观阶段（.viz-phases）+ 架构/泳道画布（<svg> 或 .viz-lanes）+ 详情检视器（.viz-inspector）`
        )
      }
    }
  }
  return false
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
      if (inspectRootInlineStyle(tag, value, report)) return true
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
  return inspectRootPalette(css, report)
}

/**
 * 根级规则里写死颜色 = 自带调色板。
 *
 * 主题变量由宿主按 --viz-* 注入；产物自己定义 :root 调色板后，宿主换肤对它完全无效，
 * 页面会永远停在作者写死的那套颜色上。这类写法按外联资源同样的方式拦下并给出改法。
 */
function inspectRootPalette(css: string, report: (message: string) => boolean): boolean {
  const source = stripCssNoise(css)
  for (const match of source.matchAll(CSS_RULE_PATTERN)) {
    // 规则前可能残留不带花括号的语句（@charset、@import），选择器从最后一个分号之后算起
    const selector = match[1].slice(match[1].lastIndexOf(';') + 1).trim()
    if (!isRootSelector(selector)) continue
    const literal = findColorLiteral(match[2])
    if (!literal) continue
    return report(`自带调色板（${snippet(selector)} { ${snippet(literal)} }）：${PALETTE_HINT}`)
  }
  return false
}

/** 只认落在根元素本身的选择器；body .card 这类后代规则是普通样式，不算调色板 */
function isRootSelector(selector: string): boolean {
  return selector.split(',').some(part => {
    const compounds = part.trim().split(CSS_COMBINATOR_PATTERN).filter(Boolean)
    return compounds.length > 0 && compounds.every(compound => ROOT_COMPOUND_PATTERN.test(compound))
  })
}

/** <html style="..."> / <body style="..."> 里的写死颜色同样属于自带调色板 */
function inspectRootInlineStyle(tag: string, value: string, report: (message: string) => boolean): boolean {
  if (tag !== 'html' && tag !== 'body') return false
  const literal = findColorLiteral(stripCssNoise(value))
  if (!literal) return false
  return report(`自带调色板（<${tag} style="${snippet(value)}">）：${PALETTE_HINT}`)
}

/** 注释、url() 与引号内容里的字符不参与颜色判定 */
function stripCssNoise(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/url\([^)]*\)/gi, ' ')
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
}

/** 第一条带颜色字面量的声明 */
function findColorLiteral(declarations: string): string | null {
  for (const declaration of declarations.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    const property = declaration.slice(0, colon).trim()
    const value = declaration.slice(colon + 1).trim()
    if (!property || !value) continue
    if (!COLOR_LITERAL_PATTERN.test(stripVarCalls(value))) continue
    return `${property}: ${value}`
  }
  return null
}

/** var() 引用的是主题变量，其中的兜底色只在变量缺失时生效，不算写死 */
function stripVarCalls(value: string): string {
  const lower = value.toLowerCase()
  let result = ''
  let index = 0
  for (let start = lower.indexOf('var(', index); start >= 0; start = lower.indexOf('var(', index)) {
    result += `${value.slice(index, start)}var()`
    let depth = 0
    for (index = start + 3; index < value.length; index++) {
      if (value[index] === '(') depth++
      else if (value[index] === ')' && --depth === 0) {
        index++
        break
      }
    }
  }
  return result + value.slice(index)
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
