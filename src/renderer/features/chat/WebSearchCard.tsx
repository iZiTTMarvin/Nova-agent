/**
 * web_search 工具结果卡片
 * 从 formatForLLM 输出的纯文本中解析并展示 answer + 可点击来源列表
 */
import React, { useState } from 'react'
import { parseWebSearchOutput } from '../../../shared/webSearch/parseOutput'

/** 默认只铺开前几个来源；其余是视觉折叠，内容与顺序不变 */
const PREVIEW_SOURCE_COUNT = 2

interface WebSearchCardProps {
  /** 工具输出的纯文本（formatForLLM 的结果） */
  output: string
  /** 是否正在搜索（加载态） */
  loading?: boolean
}

export const WebSearchCard: React.FC<WebSearchCardProps> = ({ output, loading }) => {
  const [showAllSources, setShowAllSources] = useState(false)

  if (loading) {
    return (
      <div className="web-search-card">
        <div className="web-search-card__loading">
          <span className="web-search-card__spinner" aria-hidden />
          <span>正在搜索…</span>
        </div>
      </div>
    )
  }

  const { answer, sources } = parseWebSearchOutput(output)
  const collapsible = sources.length > PREVIEW_SOURCE_COUNT
  const visibleSources = collapsible && !showAllSources ? sources.slice(0, PREVIEW_SOURCE_COUNT) : sources

  return (
    <div className="web-search-card">
      {answer && <div className="web-search-card__answer">{answer}</div>}
      {sources.length > 0 && (
        <div className="web-search-card__sources">
          <div className="web-search-card__sources-label">来源</div>
          <ol className="web-search-card__sources-list">
            {visibleSources.map((source, index) => (
              <li key={`${source.url}-${index}`} className="web-search-card__source-item">
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="web-search-card__source-title"
                >
                  {source.title}
                </a>
                <span className="web-search-card__source-url">{source.url}</span>
                {source.snippet && (
                  <p className="web-search-card__source-snippet">{source.snippet}</p>
                )}
              </li>
            ))}
          </ol>
          {collapsible && (
            <button
              type="button"
              className="web-search-card__more"
              aria-expanded={showAllSources}
              onClick={() => setShowAllSources(previous => !previous)}
            >
              {showAllSources ? '收起' : `查看完整结果（共 ${sources.length} 条来源）`}
            </button>
          )}
        </div>
      )}
      {!answer && sources.length === 0 && (
        <pre className="web-search-card__raw">{output}</pre>
      )}
    </div>
  )
}
