/**
 * MermaidDiagram — mermaid 围栏的渐进渲染
 *
 * - 所在块未封口（active tail）：只显示源码占位，不加载 mermaid
 * - 封口/终态：懒加载 mermaid → 异步 render → 注入 SVG
 * - securityLevel 'strict'：label 内 HTML 与点击跳转禁用，输出 SVG 安全
 * - SVG 按 (主题, source) 缓存：虚拟列表卸载重挂直接命中；切换深浅色时按新主题重渲染
 * - 渲染失败：错误 + 源码回退展示，内容不丢失
 */
import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { useCopyFeedback } from '../../hooks/useCopyFeedback'
import { useSettingsStore } from '../../stores/useSettingsStore'
import './MermaidDiagram.css'

type MermaidApi = typeof import('mermaid')['default']
type MermaidTheme = 'dark' | 'neutral'

let mermaidPromise: Promise<MermaidApi> | null = null
let renderSeq = 0

const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)'

function subscribeSystemScheme(onChange: () => void): () => void {
  if (typeof matchMedia !== 'function') return () => {}
  const media = matchMedia(DARK_SCHEME_QUERY)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

function isSystemDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia(DARK_SCHEME_QUERY).matches
}

/** 与根 Theme 同源：设置里的主题模式，system 档跟随系统深浅色 */
function useMermaidTheme(): MermaidTheme {
  const mode = useSettingsStore(state => state.theme)
  const systemDark = useSyncExternalStore(subscribeSystemScheme, isSystemDark)
  return mode === 'dark' || (mode === 'system' && systemDark) ? 'dark' : 'neutral'
}

function svgCacheKey(theme: MermaidTheme, source: string): string {
  return theme + '\u0000' + source
}

function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })
    return mermaid
  })
  return mermaidPromise
}

const SVG_CACHE_LIMIT = 100
const svgCache = new Map<string, string>()

interface MermaidDiagramProps {
  source: string
  /** 所在块是否已封口/终态；false 时仅占位，不触发加载与渲染 */
  renderNow: boolean
}

export const MermaidDiagram = React.memo(function MermaidDiagram({ source, renderNow }: MermaidDiagramProps) {
  const theme = useMermaidTheme()
  const [svg, setSvg] = useState<string | null>(() => svgCache.get(svgCacheKey(theme, source)) ?? null)
  const [error, setError] = useState<string | null>(null)
  const { copied, copy } = useCopyFeedback()

  useEffect(() => {
    setError(null)
    if (!renderNow) return
    const key = svgCacheKey(theme, source)
    const cached = svgCache.get(key)
    if (cached !== undefined) {
      setSvg(cached)
      return
    }
    let alive = true
    void loadMermaid()
      .then(mermaid => {
        // initialize 是全局配置：主题切换后在途的旧主题结果经 alive 丢弃，不会写进新主题的缓存
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme,
          themeVariables: { background: 'transparent' }
        })
        return mermaid.render(`nova-mermaid-${renderSeq++}`, source)
      })
      .then(result => {
        if (!alive) return
        if (svgCache.size >= SVG_CACHE_LIMIT) {
          const oldest = svgCache.keys().next().value!
          svgCache.delete(oldest)
        }
        svgCache.set(key, result.svg)
        setSvg(result.svg)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setSvg(null)
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [source, theme, renderNow])

  if (!renderNow) {
    return (
      <div className="mermaid-diagram mermaid-diagram--pending">
        <div className="mermaid-diagram__hint">图表生成中，完成后自动渲染</div>
        <pre className="mermaid-diagram__source">{source}</pre>
      </div>
    )
  }

  if (error) {
    return (
      <div className="mermaid-diagram mermaid-diagram--error">
        <div className="mermaid-diagram__hint">
          图表渲染失败：{error}
          <button
            type="button"
            className="mermaid-diagram__copy"
            onClick={() => copy(source)}
          >
            {copied ? '已复制' : '复制源码'}
          </button>
        </div>
        <pre className="mermaid-diagram__source">{source}</pre>
      </div>
    )
  }

  if (svg) {
    return <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />
  }

  return (
    <div className="mermaid-diagram mermaid-diagram--loading">
      <div className="mermaid-diagram__hint">正在渲染图表…</div>
    </div>
  )
})
