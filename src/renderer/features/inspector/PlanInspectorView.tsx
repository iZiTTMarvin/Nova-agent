import React, { useEffect, useState } from 'react'
import { IconButton } from '@astryxdesign/core/IconButton'
import type { ActivePlanDocument } from '../../../shared/workspace/types'
import { CloseIcon, CopyIcon, PlanIcon, SpinnerIcon } from '../../components/Icons'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'

export const PlanInspectorView: React.FC = () => {
  const target = useLayoutStore(state => state.planTarget)
  const closeInspector = useLayoutStore(state => state.closeInspector)
  const [document, setDocument] = useState<ActivePlanDocument | null>(null)
  const [loading, setLoading] = useState(true)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!target) {
      setDocument(null)
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    setStale(false)
    setCopied(false)

    const load = async () => {
      try {
        const expected = await window.api.invoke('workspace:read-active-plan', {
          sessionId: target.sessionId,
          ...(target.expectedPath ? { expectedPath: target.expectedPath } : {})
        })
        if (cancelled) return
        if (expected) {
          setDocument(expected)
          return
        }

        const current = await window.api.invoke('workspace:read-active-plan', {
          sessionId: target.sessionId
        })
        if (cancelled) return
        setDocument(current)
        if (current) setStale(true)
        else setError('当前会话没有可读取的计划。')
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [target?.expectedPath, target?.messageId, target?.sessionId, target?.toolCallId])

  const copy = async () => {
    if (!document) return
    try {
      await navigator.clipboard.writeText(document.content)
      setCopied(true)
    } catch {
      setError('复制计划失败，请重试。')
    }
  }

  return (
    <div className="inspector-plan">
      <header className="inspector-plan__header">
        <span className="inspector-plan__icon" aria-hidden="true"><PlanIcon size={16} /></span>
        <div className="inspector-plan__heading">
          <span>计划</span>
          <strong>{document?.title ?? '实施计划'}</strong>
        </div>
        <IconButton
          label={copied ? '已复制计划' : '复制完整计划'}
          icon={<CopyIcon size={14} />}
          variant="ghost"
          size="sm"
          onClick={() => void copy()}
          isDisabled={!document}
          tooltip={copied ? '已复制' : '复制完整计划'}
        />
        <button
          type="button"
          className="inspector-icon-btn"
          aria-label="关闭计划"
          onClick={() => closeInspector()}
        >
          <CloseIcon size={14} />
        </button>
      </header>

      {stale && (
        <div className="inspector-plan__banner">
          这张计划卡已被更新，当前显示会话中的最新计划。
        </div>
      )}

      <div className="inspector-plan__body">
        {loading ? (
          <div className="inspector-plan__state"><SpinnerIcon size={16} />正在读取完整计划…</div>
        ) : error && !document ? (
          <div className="inspector-plan__state inspector-plan__state--error">{error}</div>
        ) : document ? (
          <article className="inspector-plan__document">
            <MarkdownRenderer content={document.content} />
          </article>
        ) : null}
      </div>
      {error && document && <div className="inspector-plan__error" role="alert">{error}</div>}
    </div>
  )
}
