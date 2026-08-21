import React, { useEffect, useMemo, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu'
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
  /** 是否消息流中最后一张成功保存的计划卡；历史/旧轮次卡片只读，防止对旧计划内容重复实施 */
  isLatestPlan?: boolean
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

/** 实施指令未发出时尽力把模式切回 plan，保证卡片留下重试入口；返回回滚是否成功 */
async function rollbackToPlan(): Promise<boolean> {
  try {
    await useSettingsStore.getState().setMode('plan')
    return true
  } catch {
    return false
  }
}

/** 实施指令未发出时的统一文案：回滚成功提示可重试，失败则提示手动切回 */
function sendFailureMessage(detail: string | null, rolledBack: boolean): string {
  const prefix = detail ? `实施指令未能发出（${detail}）` : '实施指令未能发出'
  return rolledBack
    ? `${prefix}，已切回计划模式，请重试`
    : `${prefix}，且无法自动切回计划模式，请手动切换后重试`
}

export const PlanReviewCard: React.FC<PlanReviewCardProps> = React.memo(function PlanReviewCard({
  sessionId,
  currentMode,
  status,
  args,
  result,
  turnActive,
  isLatestPlan = true,
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
  const [decisionMenuOpen, setDecisionMenuOpen] = useState(false)

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
    status !== 'success' || turnActive || document === null || submitting || !isLatestPlan
      ? false
      : currentMode === 'compose'
        ? composeStageId === 'plan' && composePlanApproval?.status !== 'approved'
        : currentMode === 'plan'
  const statusLabel = status === 'running'
    ? '正在生成计划'
    : status === 'error'
      ? '计划生成失败'
      : '计划待审阅'

  /** 卡片动作绑定卡片所属会话；切走后点击旧卡片必须拒绝，避免两步异步间指令发进错误会话 */
  const ensureCurrentSession = (): boolean => {
    if (useChatStore.getState().currentSessionId === sessionId) return true
    setActionError('页面已切换到其他会话，请回到该计划所属会话操作')
    return false
  }

  const startImplementation = async () => {
    if (!canApprove || currentMode !== 'plan') return
    if (!ensureCurrentSession()) return
    setSubmitting(true)
    setActionError(null)
    let modeSwitched = false
    try {
      await useSettingsStore.getState().setMode('default')
      modeSwitched = true
      const sent = await useChatStore.getState().sendMessage(
        '请读取当前 active plan，结合最新仓库状态开始实施，并在完成后运行相关验证。',
        []
      )
      if (sent) return
      // 守卫拒绝（Agent 忙/缺项目路径）：模式已切走，回滚到 plan 保住卡片重试入口
      setActionError(sendFailureMessage(null, await rollbackToPlan()))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setActionError(
        modeSwitched
          ? sendFailureMessage(detail, await rollbackToPlan())
          // setMode 自身失败：模式从未切走，无需回滚
          : `切换模式失败：${detail}`
      )
    } finally {
      setSubmitting(false)
    }
  }

  /** compose 阶段的「继续完善」：只把修订提示送入输入框，模式与阶段由确认门管理 */
  const continuePlanning = () => {
    useSettingsStore.getState().requestComposerPrefill('请按以下要求继续完善当前计划：\n')
  }

  /**
   * 需要更正：停留在 plan 模式，把「用户不批准、要求更正」作为用户消息发给模型；
   * 模型正常追问要改什么后结束本轮，等待用户回复，不复用 askQuestion 做审批交互。
   */
  const requestCorrection = async () => {
    if (!canApprove || currentMode !== 'plan') return
    if (!ensureCurrentSession()) return
    setSubmitting(true)
    setActionError(null)
    try {
      const sent = await useChatStore.getState().sendMessage(
        '这份计划需要更正，暂不执行。请询问我希望调整哪些部分，然后等待我的回复。',
        []
      )
      if (!sent) {
        setActionError('更正请求未能发出（Agent 可能仍在运行），请稍后手动发送。')
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  const approveComposePlan = async () => {
    if (!canApprove || currentMode !== 'compose') return
    if (!ensureCurrentSession()) return
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
          ) : isLatestPlan ? (
            <>
              <span className="plan-review-card__prompt">确认计划后再允许编辑项目文件</span>
              <div className="plan-review-card__decision">
                <Button
                  label={submitting ? '正在切换…' : turnActive ? '等待回复完成' : '执行'}
                  variant="primary"
                  size="sm"
                  className="plan-review-card__primary"
                  onClick={() => void startImplementation()}
                  isDisabled={!canApprove}
                />
                <DropdownMenu
                  className="plan-review-card__decision-menu"
                  placement="above"
                  menuWidth={176}
                  isMenuOpen={decisionMenuOpen}
                  onOpenChange={setDecisionMenuOpen}
                  button={{
                    label: '更多计划决策',
                    variant: 'primary',
                    size: 'sm',
                    isIconOnly: true,
                    icon: <ChevronIcon size={14} direction="down" />,
                    tooltip: '更多计划决策',
                    isDisabled: !canApprove
                  }}
                >
                  {/* Button 承载菜单行，与 ModeSwitch 一致保持在 Astryx 焦点路径上 */}
                  <Button
                    label="需要更正"
                    variant="ghost"
                    size="sm"
                    width="100%"
                    role="menuitem"
                    tabIndex={-1}
                    className="plan-review-card__decision-item"
                    onClick={() => {
                      setDecisionMenuOpen(false)
                      void requestCorrection()
                    }}
                    isDisabled={!canApprove}
                  />
                </DropdownMenu>
              </div>
            </>
          ) : (
            /* 历史/旧轮次计划卡：内容仍可展开阅读，但不提供决策，避免对旧计划内容重复实施 */
            <span className="plan-review-card__outdated">
              已有更新的计划版本，请以最新的计划卡片为准
            </span>
          )}
        </div>
      )}
      {actionError && <div className="plan-review-card__action-error">{actionError}</div>}
    </section>
  )
})
