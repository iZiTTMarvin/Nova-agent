import React, { useEffect, useMemo, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import type { Mode } from '../../../shared/session/types'
import type { ActivePlanDocument } from '../../../shared/workspace/types'
import type { ComposePlanApproval, ComposeStageId } from '../../../shared/composeLifecycle'
import { isContentSummary, type ContentSummary } from '../../../shared/tool-input-sanitizer'
import { CheckIcon, ChevronIcon, PlanIcon, SpinnerIcon } from '../../components/Icons'
import { useChatStore } from '../../stores/useChatStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { MarkdownRenderer } from './MarkdownRenderer'
import './PlanReviewCard.css'

export interface PlanReviewCardProps {
  sessionId: string
  currentMode: Mode
  status: 'running' | 'success' | 'error'
  args: Record<string, unknown>
  result?: string
  turnActive: boolean
  /** 仅 compose 模式：当前生命周期阶段，用于判断计划确认门是否生效 */
  composeStageId?: ComposeStageId | null
  /** 仅 compose 模式：计划确认门状态，null/undefined 视为 pending */
  composePlanApproval?: ComposePlanApproval | null
}

function previewFromArgs(content: unknown): string {
  if (typeof content === 'string') return content
  if (!isContentSummary(content)) return ''
  const summary = content as ContentSummary
  return `${summary.content_head}\n\n> ……完整计划正在从项目文件加载……\n\n${summary.content_tail}`
}

function pathFromResult(result: string | undefined): string | null {
  const match = result?.match(/计划已保存到 "([^"]+)"/u)
  return match?.[1] ?? null
}

export const PlanReviewCard: React.FC<PlanReviewCardProps> = React.memo(function PlanReviewCard({
  sessionId,
  currentMode,
  status,
  args,
  result,
  turnActive,
  composeStageId = null,
  composePlanApproval = null
}) {
  const title = typeof args.title === 'string' && args.title.trim()
    ? args.title.trim()
    : '实施计划'
  const preview = useMemo(() => previewFromArgs(args.content), [args.content])
  const resultPath = useMemo(() => pathFromResult(result), [result])
  const [document, setDocument] = useState<ActivePlanDocument | null>(null)
  const [loading, setLoading] = useState(status === 'success')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    if (status !== 'success') {
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setDocument(null)
    setLoadError(null)
    void window.api.invoke('workspace:read-active-plan', {
      sessionId,
      ...(resultPath ? { expectedPath: resultPath } : {})
    }).then(activePlan => {
      if (cancelled) return
      setDocument(activePlan)
      if (!activePlan) {
        setLoadError('当前 active plan 已变化或文件不可读取，请重新生成计划。')
      }
    }).catch(error => {
      if (cancelled) return
      setLoadError(error instanceof Error ? error.message : String(error))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [resultPath, sessionId, status])

  const content = document?.content ?? preview
  const planPath = document?.path ?? resultPath
  const canApprove =
    status !== 'success' || turnActive || document === null || submitting
      ? false
      : currentMode === 'compose'
        ? composeStageId === 'plan' && composePlanApproval?.status !== 'approved'
        : currentMode === 'plan'
  const statusLabel = status === 'running'
    ? '正在生成计划'
    : status === 'error'
      ? '计划生成失败'
      : '计划待审阅'

  const startImplementation = async () => {
    if (!canApprove || currentMode !== 'plan') return
    setSubmitting(true)
    setActionError(null)
    try {
      await useSettingsStore.getState().setMode('default')
      const sent = await useChatStore.getState().sendMessage(
        '请读取当前 active plan，结合最新仓库状态开始实施，并在完成后运行相关验证。',
        []
      )
      if (!sent) {
        setActionError('实施指令未能发出（Agent 可能仍在运行），请稍后手动发送。')
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  const approveComposePlan = async () => {
    if (!canApprove || currentMode !== 'compose') return
    setSubmitting(true)
    setActionError(null)
    try {
      const approval = await window.api.invoke('compose:approve-plan', { sessionId })
      if (!approval.ok) {
        setActionError(approval.error)
        return
      }
      const sent = await useChatStore.getState().sendMessage(
        '计划已批准，请先调用 todo_write 把计划任务清单导入为待办，再调用 stage_transition 进入「开发」阶段。',
        []
      )
      if (!sent) {
        setActionError('批准已生效，但引导指令未能发出（Agent 可能仍在运行），请稍后手动发送。')
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  const continuePlanning = () => {
    useSettingsStore.getState().requestComposerPrefill('请按以下要求继续完善当前计划：\n')
  }

  return (
    <section className={`plan-review-card plan-review-card--${status}`} aria-label="计划审阅">
      <Button
        label={`${statusLabel} · ${title}`}
        variant="ghost"
        size="md"
        className="plan-review-card__header"
        onClick={() => setExpanded(value => !value)}
        aria-expanded={expanded}
        icon={<span className="plan-review-card__icon" aria-hidden="true">
          {status === 'running' ? <SpinnerIcon size={16} /> : <PlanIcon size={16} />}
        </span>}
        endContent={<ChevronIcon size={14} direction={expanded ? 'up' : 'down'} />}
      />

      {expanded && (
        <div className="plan-review-card__body">
          {planPath && (
            <div className="plan-review-card__path" title={planPath}>{planPath}</div>
          )}
          {loading && !content && (
            <div className="plan-review-card__loading">
              <SpinnerIcon size={15} />
              正在从当前项目读取完整计划…
            </div>
          )}
          {content && (
            <div className="plan-review-card__document">
              <MarkdownRenderer content={content} />
            </div>
          )}
          {loadError && <div className="plan-review-card__error">{loadError}</div>}
          {status === 'error' && result && (
            <div className="plan-review-card__error">{result}</div>
          )}
        </div>
      )}

      {status === 'success' && (
        <div className="plan-review-card__footer">
          {currentMode === 'default' ? (
            <span className="plan-review-card__implemented">
              <CheckIcon size={14} />
              已进入默认模式
            </span>
          ) : currentMode === 'compose' ? (
            composePlanApproval?.status === 'approved' ? (
              <span className="plan-review-card__implemented">
                <CheckIcon size={14} />
                {composePlanApproval.auto ? '已自动批准（auto 模式）' : '已批准，进入「开发」阶段'}
              </span>
            ) : composeStageId === 'plan' ? (
              <>
                <span className="plan-review-card__prompt">确认计划后再允许编辑项目文件</span>
                <Button
                  label="继续完善"
                  variant="secondary"
                  size="sm"
                  className="plan-review-card__secondary"
                  onClick={continuePlanning}
                  isDisabled={submitting || turnActive}
                />
                <Button
                  label={submitting ? '正在批准…' : turnActive ? '等待回复完成' : '批准并开始开发'}
                  variant="primary"
                  size="sm"
                  className="plan-review-card__primary"
                  onClick={() => void approveComposePlan()}
                  isDisabled={!canApprove}
                />
              </>
            ) : null
          ) : (
            <>
              <span className="plan-review-card__prompt">确认计划后再允许编辑项目文件</span>
              <Button
                label="继续完善"
                variant="secondary"
                size="sm"
                className="plan-review-card__secondary"
                onClick={continuePlanning}
                isDisabled={submitting || turnActive}
              />
              <Button
                label={submitting ? '正在切换…' : turnActive ? '等待回复完成' : '开始实施'}
                variant="primary"
                size="sm"
                className="plan-review-card__primary"
                onClick={() => void startImplementation()}
                isDisabled={!canApprove}
              />
            </>
          )}
        </div>
      )}
      {actionError && <div className="plan-review-card__action-error">{actionError}</div>}
    </section>
  )
})
