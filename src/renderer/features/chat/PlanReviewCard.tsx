import React, { useEffect, useMemo, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { IconButton } from '@astryxdesign/core/IconButton'
import type { ActivePlanDocument } from '../../../shared/workspace/types'
import { isContentSummary, type ContentSummary } from '../../../shared/tool-input-sanitizer'
import { CopyIcon, PlanIcon, SpinnerIcon } from '../../components/Icons'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { MarkdownRenderer } from './MarkdownRenderer'
import './PlanReviewCard.css'

export interface PlanReviewCardProps {
  sessionId: string
  messageId: string
  toolCallId: string
  status: 'running' | 'success' | 'error'
  args: Record<string, unknown>
  result?: string
}

function previewFromArgs(content: unknown): string {
  if (typeof content === 'string') return content
  if (!isContentSummary(content)) return ''
  const summary = content as ContentSummary
  return `${summary.content_head}\n\n${summary.content_tail}`
}

export function planPathFromResult(result: string | undefined): string | null {
  const match = result?.match(/计划已保存到 "([^"]+)"/u)
  return match?.[1] ?? null
}

export const PlanReviewCard: React.FC<PlanReviewCardProps> = React.memo(function PlanReviewCard({
  sessionId,
  messageId,
  toolCallId,
  status,
  args,
  result
}) {
  const title = typeof args.title === 'string' && args.title.trim()
    ? args.title.trim()
    : '实施计划'
  const preview = useMemo(() => previewFromArgs(args.content), [args.content])
  const expectedPath = useMemo(() => planPathFromResult(result), [result])
  const openPlan = useLayoutStore(state => state.openPlan)
  const inspectorSurface = useLayoutStore(state => state.inspectorSurface)
  const planTarget = useLayoutStore(state => state.planTarget)
  const [document, setDocument] = useState<ActivePlanDocument | null>(null)
  const [loading, setLoading] = useState(status === 'success')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')

  useEffect(() => {
    setDocument(null)
    setLoadError(null)
    setCopyState('idle')
    if (status !== 'success') {
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    void window.api.invoke('workspace:read-active-plan', {
      sessionId,
      ...(expectedPath ? { expectedPath } : {})
    }).then(activePlan => {
      if (cancelled) return
      setDocument(activePlan)
      if (!activePlan) {
        setLoadError('当前计划已更新或文件不可读取。')
      }
    }).catch(error => {
      if (!cancelled) {
        setLoadError(error instanceof Error ? error.message : String(error))
      }
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [expectedPath, sessionId, status, toolCallId])

  useEffect(() => {
    if (
      inspectorSurface !== 'plan' ||
      planTarget?.sessionId !== sessionId ||
      planTarget.messageId !== messageId ||
      planTarget.toolCallId === toolCallId
    ) {
      return
    }
    openPlan({
      sessionId,
      messageId,
      toolCallId,
      ...(expectedPath ? { expectedPath } : {})
    })
  }, [expectedPath, inspectorSurface, messageId, openPlan, planTarget, sessionId, toolCallId])

  const content = document?.content ?? preview
  const copyPlan = async () => {
    if (!content) return
    try {
      await navigator.clipboard.writeText(content)
      setCopyState('copied')
    } catch {
      setCopyState('error')
    }
  }

  const viewFullPlan = () => {
    openPlan({
      sessionId,
      messageId,
      toolCallId,
      ...(expectedPath ? { expectedPath } : {})
    })
  }

  return (
    <section className={`plan-review-card plan-review-card--${status}`} aria-label="计划">
      <header className="plan-review-card__header">
        <span className="plan-review-card__icon" aria-hidden="true">
          {status === 'running' ? <SpinnerIcon size={16} /> : <PlanIcon size={16} />}
        </span>
        <span className="plan-review-card__label">
          {status === 'running' ? '正在生成计划' : status === 'error' ? '计划生成失败' : '计划'}
        </span>
        <IconButton
          label={copyState === 'copied' ? '已复制计划' : '复制完整计划'}
          icon={<CopyIcon size={14} />}
          variant="ghost"
          size="sm"
          onClick={() => void copyPlan()}
          isDisabled={!content}
          tooltip={copyState === 'error' ? '复制失败，请重试' : copyState === 'copied' ? '已复制' : '复制完整计划'}
        />
      </header>

      <div className="plan-review-card__body">
        <h2 className="plan-review-card__title">{title}</h2>
        {loading && !content ? (
          <div className="plan-review-card__state">
            <SpinnerIcon size={15} />
            正在读取计划…
          </div>
        ) : content ? (
          <div className="plan-review-card__preview">
            <MarkdownRenderer content={content} />
          </div>
        ) : null}
        {(loadError || status === 'error') && (
          <div className="plan-review-card__error">{loadError ?? result ?? '计划生成失败'}</div>
        )}
        {content && <div className="plan-review-card__fade" aria-hidden="true" />}
      </div>

      <footer className="plan-review-card__footer">
        <Button
          label="查看完整计划 →"
          variant="secondary"
          size="sm"
          className="plan-review-card__view"
          onClick={viewFullPlan}
          isDisabled={status !== 'success' || document === null}
        />
      </footer>
    </section>
  )
})
