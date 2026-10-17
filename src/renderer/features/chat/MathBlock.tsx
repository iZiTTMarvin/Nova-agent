/**
 * MathBlock — KaTeX 公式渲染单元
 *
 * - 懒加载：首个公式挂载才加载 KaTeX 脚本与样式，两者都就绪前显示公式原文；
 *   样式随脚本一起按需加载，不进入首屏
 * - renderToString 结果按 (source, displayMode) LRU 缓存：
 *   active tail 逐帧重渲染时，已稳定的公式零成本命中
 * - throwOnError:false：公式语法错误红字内联展示，不炸整条消息
 * - KaTeX 默认 trust:false，输出 HTML 不含脚本类注入面
 */
import React, { useEffect, useState } from 'react'
import { Code as AstryxInlineCode } from '@astryxdesign/core/Code'
import { unwrapInlineMathCode } from './mathSyntax'
import './MathBlock.css'

type KatexApi = typeof import('katex')['default']

let katexPromise: Promise<KatexApi> | null = null
let katexRef: KatexApi | null = null

/** 确保 KaTeX 已加载（幂等）；组件挂载与测试直接调用 */
export function ensureKatexLoaded(): Promise<KatexApi> {
  // 无样式的 KaTeX 输出会同时露出 MathML 与 HTML 两份文本：样式到位才算就绪
  katexPromise ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([mod]) => {
    katexRef = mod.default
    return mod.default
  })
  return katexPromise
}

const HTML_CACHE_LIMIT = 2000
const htmlCache = new Map<string, string>()

/** 测试钩子：当前 katex 是否已就绪 */
export function isKatexLoaded(): boolean {
  return katexRef !== null
}

export function renderMathToHtml(source: string, displayMode: boolean): string {
  const key = (displayMode ? 'D' : 'I') + '\u0000' + source
  const hit = htmlCache.get(key)
  if (hit !== undefined) {
    htmlCache.delete(key)
    htmlCache.set(key, hit)
    return hit
  }
  let html: string
  try {
    html = katexRef!.renderToString(source, {
      displayMode,
      throwOnError: false,
      strict: false,
      trust: false
    })
  } catch {
    html = ''
  }
  if (htmlCache.size >= HTML_CACHE_LIMIT) {
    const oldest = htmlCache.keys().next().value!
    htmlCache.delete(oldest)
  }
  htmlCache.set(key, html)
  return html
}

interface MathSpanProps {
  source: string
  display: boolean
}

const MathSpan = React.memo(function MathSpan({ source, display }: MathSpanProps) {
  const [ready, setReady] = useState(katexRef !== null)

  useEffect(() => {
    if (katexRef !== null) return
    let alive = true
    void ensureKatexLoaded().then(() => {
      if (alive) setReady(true)
    })
    return () => {
      alive = false
    }
  }, [])

  if (!ready) {
    return display
      ? <div className="math-block math-block--raw">{source}</div>
      : <span className="math-inline math-inline--raw">{source}</span>
  }
  const html = renderMathToHtml(source, display)
  if (!html) {
    return display
      ? <div className="math-block math-block--raw">{source}</div>
      : <span className="math-inline math-inline--raw">{source}</span>
  }
  return display
    ? <div className="math-block" dangerouslySetInnerHTML={{ __html: html }} />
    : <span className="math-inline" dangerouslySetInnerHTML={{ __html: html }} />
})

/** 行内代码通路：`$...$` 形态渲染公式，其余透传 Astryx 默认行内代码 */
export function MathInlineCode({ children }: { children: string }): React.ReactElement {
  const source = unwrapInlineMathCode(children)
  if (source !== null) {
    return <MathSpan source={source} display={false} />
  }
  return <AstryxInlineCode>{children}</AstryxInlineCode>
}

/** ```math 围栏通路：整块作为 display 公式渲染 */
export function MathFence({ code }: { code: string }): React.ReactElement {
  return <MathSpan source={code} display={true} />
}

/** components.code 的数学语言集合 */
export const MATH_FENCE_LANGUAGES = new Set(['math', 'latex', 'katex', 'tex'])
