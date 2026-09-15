/**
 * 正文提取：HTML → Readability 主内容 → Turndown Markdown。
 * 质量地板：短且命中 JS 壳信号才报错；仅短则降级返回原文+警告（不误杀合法短页）。
 * 非 HTML（JSON/纯文本）按原文返回，不进提取链。
 *
 * 三个提取库必须动态 import：主进程 bundle 是 CJS，这几个包（及其依赖
 * css-select）是纯 ESM，静态 import 会在启动时 ERR_REQUIRE_ESM 崩溃。
 */
import type { Readability } from '@mozilla/readability'

type ExtractionLibs = {
  ReadabilityCtor: typeof Readability
  parseHTML: (html: string) => { document: Document }
  TurndownService: new (options: Record<string, unknown>) => {
    turndown: (html: string) => string
    remove: (selectors: string[]) => unknown
  }
}

let libsPromise: Promise<ExtractionLibs> | null = null

function loadExtractionLibs(): Promise<ExtractionLibs> {
  if (!libsPromise) {
    libsPromise = (async () => {
      const [readability, linkedom, turndown] = await Promise.all([
        import('@mozilla/readability'),
        import('linkedom'),
        import('turndown')
      ])
      const TurndownService = (turndown as unknown as { default: ExtractionLibs['TurndownService'] }).default
      return {
        ReadabilityCtor: readability.Readability,
        parseHTML: linkedom.parseHTML,
        TurndownService
      }
    })()
  }
  return libsPromise
}

/** 提取正文低于该字符数视为"短" */
const MIN_CONTENT_CHARS = 200

/** JS 壳信号：命中说明页面需要渲染，静态抓取拿不到内容 */
const JS_SHELL_SIGNALS: readonly string[] = [
  'please enable javascript',
  'enable javascript to',
  'javascript is disabled',
  '需要 javascript',
  '请启用 javascript',
  'noscript'
]

export type ExtractionResult =
  | { kind: 'markdown'; markdown: string; title?: string }
  | { kind: 'raw'; text: string }
  | { kind: 'js-shell'; detail: string }
  | { kind: 'short-with-warning'; text: string }

function looksLikeHtml(contentType: string | undefined, body: string): boolean {
  if (contentType?.includes('text/html') || contentType?.includes('application/xhtml+xml')) return true
  if (!contentType && /^\s*<(!doctype|html)/i.test(body)) return true
  return false
}

function stripToText(body: string): string {
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function judgeQuality(text: string, title?: string): ExtractionResult {
  const normalized = text.toLowerCase()
  const shellHit = JS_SHELL_SIGNALS.find(signal => normalized.includes(signal))
  if (text.length < MIN_CONTENT_CHARS) {
    if (shellHit) {
      return { kind: 'js-shell', detail: '页面过短且命中 JS 渲染特征，静态抓取拿不到内容' }
    }
    return { kind: 'short-with-warning', text }
  }
  return { kind: 'markdown', markdown: text, title }
}

export async function extractContent(
  body: string,
  contentType: string | undefined
): Promise<ExtractionResult> {
  if (!looksLikeHtml(contentType, body)) {
    return { kind: 'raw', text: body }
  }

  try {
    const { ReadabilityCtor, parseHTML, TurndownService } = await loadExtractionLibs()
    const dom = parseHTML(body)
    const article = new ReadabilityCtor(dom.document).parse()
    if (article?.content) {
      const turndown = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-'
      })
      turndown.remove(['script', 'style', 'noscript'])
      const markdown = turndown.turndown(article.content)
      return judgeQuality(markdown, article.title ?? undefined)
    }
  } catch {
    // 提取器抛错（畸形 HTML 等）时走降级：原文去脚本
  }
  return judgeQuality(stripToText(body))
}
