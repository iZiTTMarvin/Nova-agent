/**
 * ComposeStageBar — compose 主会话顶部的生命周期阶段条
 *
 * 职责：
 * - 六节点横排细线串联，实时反映阶段表（当前呼吸高亮 / 完成 ✓ / 跳过 ⊘ / 待办灰）
 * - 点击已完成/已跳过（或带回退原因的进行中）节点展开详情：状态、原因、完成时间；
 *   计划阶段附带 active plan 标题/路径与「打开计划文件」入口
 * - 右端「⋯」菜单提供手动推进/回退兜底：完成需经菜单点击，跳过/回退必须填原因，
 *   统一走 compose:apply-stage-transition（与 stage_transition 工具同一套校验）；
 *   阶段表只由 main 推送的 agent:compose-stages-updated 更新，本地不做乐观写
 */
import React, { useCallback, useEffect, useState } from 'react'
import type {
  ComposeStageAction,
  ComposeStageId,
  ComposeStageStatus
} from '../../../shared/composeLifecycle'
import type { ActivePlanDocument } from '../../../shared/workspace/types'
import {
  selectSessionComposeStages,
  useComposeStageStore
} from './useComposeStageStore'
import { projectStageBar, type StageNodeProjection } from './stageBarProjection'
import { selectSessionTodoState, useTodoStore } from '../todo/useTodoStore'
import { TodoItemRow } from '../todo/TodoItemRow'
import './ComposeStageBar.css'

interface ComposeStageBarProps {
  sessionId: string
  /** 生成中锁定手动操作（与生命周期工具的写入门禁对齐） */
  interactionLocked: boolean
}

type ActionFormState =
  | { kind: 'skip' }
  | { kind: 'return'; targetStage: ComposeStageId }

const STAGE_STATUS_LABELS: Record<ComposeStageStatus, string> = {
  pending: '待办',
  in_progress: '进行中',
  completed: '已完成',
  skipped: '已跳过'
}

function formatStageTime(ts: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(ts))
}

/** 节点是否可展开详情：完成/跳过必有记录；进行中仅在携带回退原因或有开发进度时可展开 */
function canExpandNode(node: StageNodeProjection): boolean {
  return (
    node.status === 'completed' ||
    node.status === 'skipped' ||
    !!node.note ||
    (node.id === 'implement' && !!node.progress)
  )
}

function nodeLabel(node: StageNodeProjection): string {
  // 清单被清空（total=0）时不拼进度，避免出现「开发 ● 0/0」这种噪声标签
  return node.progress && node.progress.total > 0
    ? `${node.label} ● ${node.progress.completed}/${node.progress.total}`
    : node.label
}

function nodeTitle(node: StageNodeProjection): string {
  const status = STAGE_STATUS_LABELS[node.status]
  const parts = [`${node.label}：${status}`]
  if (node.progress && node.progress.total > 0) parts.push(`任务完成 ${node.progress.completed}/${node.progress.total}`)
  if (node.note) parts.push(`原因：${node.note}`)
  if (node.completedAt) parts.push(`完成于 ${formatStageTime(node.completedAt)}`)
  if (canExpandNode(node)) parts.push('点击查看详情')
  return parts.join('，')
}

export const ComposeStageBar: React.FC<ComposeStageBarProps> = ({
  sessionId,
  interactionLocked
}) => {
  const stages = useComposeStageStore((state) => selectSessionComposeStages(state, sessionId))
  const todoState = useTodoStore((state) => selectSessionTodoState(state, sessionId))
  const implementProgress = todoState ? { completed: todoState.completed, total: todoState.total } : undefined
  const projection = projectStageBar(stages, implementProgress)

  const [expandedStageId, setExpandedStageId] = useState<ComposeStageId | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [form, setForm] = useState<ActionFormState | null>(null)
  const [reason, setReason] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // 计划节点详情：按需拉取 active plan 文档（标题/路径）
  const [planDoc, setPlanDoc] = useState<ActivePlanDocument | null>(null)
  const [planLoading, setPlanLoading] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)

  const closeOverlays = useCallback(() => {
    setMenuOpen(false)
    setForm(null)
    setReason('')
    setActionError(null)
  }, [])

  // 切会话时收起全部浮层与详情，避免串会话残留
  useEffect(() => {
    setExpandedStageId(null)
    closeOverlays()
  }, [sessionId, closeOverlays])

  useEffect(() => {
    if (expandedStageId !== 'plan') return
    let cancelled = false
    setPlanLoading(true)
    setPlanDoc(null)
    setPlanError(null)
    void window.api.invoke('workspace:read-active-plan', { sessionId })
      .then((doc) => {
        if (!cancelled) setPlanDoc(doc)
      })
      .catch((err) => {
        if (!cancelled) setPlanError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setPlanLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [expandedStageId, sessionId])

  const runTransition = useCallback(async (action: ComposeStageAction) => {
    setSubmitting(true)
    setActionError(null)
    try {
      const result = await window.api.invoke('compose:apply-stage-transition', { sessionId, action })
      if (result.ok) {
        closeOverlays()
      } else {
        setActionError(result.error)
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }, [sessionId, closeOverlays])

  const submitForm = useCallback(() => {
    if (!form) return
    const trimmed = reason.trim()
    if (!trimmed) return
    if (form.kind === 'skip') {
      void runTransition({ type: 'skip', reason: trimmed })
    } else {
      void runTransition({ type: 'return', targetStage: form.targetStage, reason: trimmed })
    }
  }, [form, reason, runTransition])

  const openPlanFile = useCallback(async () => {
    setPlanError(null)
    try {
      await window.api.invoke('workspace:open-active-plan', { sessionId })
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err))
    }
  }, [sessionId])

  const expandedNode = expandedStageId
    ? projection.nodes.find((node) => node.id === expandedStageId) ?? null
    : null
  const currentLabel = projection.currentStageId
    ? projection.nodes.find((node) => node.id === projection.currentStageId)?.label ?? ''
    : ''
  const menuDisabled = interactionLocked || submitting
  const overlayOpen = menuOpen || form !== null

  return (
    <section
      className="compose-stage-bar"
      aria-label="生命周期阶段"
      onKeyDown={(e) => {
        if (e.key === 'Escape') closeOverlays()
      }}
    >
      <div className="compose-stage-bar__row">
        <ol className="compose-stage-bar__track">
          {projection.nodes.map((node, index) => {
            const connectorDone =
              index > 0 &&
              (projection.nodes[index - 1].status === 'completed' ||
                projection.nodes[index - 1].status === 'skipped')
            const expandable = canExpandNode(node)
            const expanded = expandedStageId === node.id
            const nodeBody = (
              <>
                <span className="compose-stage-bar__glyph" aria-hidden="true">
                  {node.status === 'completed' ? '✓' : node.status === 'skipped' ? '⊘' : ''}
                </span>
                <span className="compose-stage-bar__label">{nodeLabel(node)}</span>
              </>
            )
            return (
              <li className="compose-stage-bar__item" key={node.id}>
                {index > 0 && (
                  <span
                    className={`compose-stage-bar__connector${connectorDone ? ' compose-stage-bar__connector--done' : ''}`}
                    aria-hidden="true"
                  />
                )}
                {expandable ? (
                  <button
                    type="button"
                    className={`compose-stage-bar__node compose-stage-bar__node--${node.status}${expanded ? ' compose-stage-bar__node--expanded' : ''}`}
                    aria-current={node.isCurrent ? 'step' : undefined}
                    aria-expanded={expanded}
                    title={nodeTitle(node)}
                    onClick={() => setExpandedStageId(expanded ? null : node.id)}
                  >
                    {nodeBody}
                  </button>
                ) : (
                  <span
                    className={`compose-stage-bar__node compose-stage-bar__node--${node.status}`}
                    aria-current={node.isCurrent ? 'step' : undefined}
                    title={nodeTitle(node)}
                  >
                    {nodeBody}
                  </span>
                )}
              </li>
            )
          })}
        </ol>
        <button
          type="button"
          className="compose-stage-bar__menu-trigger"
          aria-label="阶段操作"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={menuDisabled}
          title={interactionLocked ? 'Agent 运行中，暂不能手动调整阶段' : '手动调整阶段'}
          onClick={() => {
            setActionError(null)
            setForm(null)
            setMenuOpen((open) => !open)
          }}
        >
          ⋯
        </button>
      </div>

      {overlayOpen && (
        <div className="compose-stage-bar__backdrop" onClick={closeOverlays} aria-hidden="true" />
      )}

      {menuOpen && (
        <div className="compose-stage-bar__menu" role="menu" aria-label="阶段操作">
          <button
            type="button"
            role="menuitem"
            className="compose-stage-bar__menu-item"
            disabled={!projection.currentStageId}
            title={projection.currentStageId ? `完成「${currentLabel}」并进入下一阶段` : '生命周期已结束'}
            onClick={() => void runTransition({ type: 'complete' })}
          >
            完成当前阶段
          </button>
          <button
            type="button"
            role="menuitem"
            className="compose-stage-bar__menu-item"
            disabled={!projection.currentStageId}
            title={projection.currentStageId ? `跳过「${currentLabel}」（需填写原因）` : '生命周期已结束'}
            onClick={() => {
              setMenuOpen(false)
              setForm({ kind: 'skip' })
            }}
          >
            跳过当前阶段…
          </button>
          <button
            type="button"
            role="menuitem"
            className="compose-stage-bar__menu-item"
            disabled={projection.returnTargets.length === 0}
            title={projection.returnTargets.length > 0 ? '回退到之前的阶段（需填写原因）' : '当前没有可回退的阶段'}
            onClick={() => {
              setMenuOpen(false)
              const first = projection.returnTargets[0]
              if (first) setForm({ kind: 'return', targetStage: first.id })
            }}
          >
            回退到…
          </button>
        </div>
      )}

      {form && (
        <div className="compose-stage-bar__form" role="group" aria-label={form.kind === 'skip' ? '跳过阶段' : '回退阶段'}>
          <span className="compose-stage-bar__form-title">
            {form.kind === 'skip' ? `跳过「${currentLabel}」` : '回退阶段'}
          </span>
          {form.kind === 'return' && (
            <div className="compose-stage-bar__form-targets" role="radiogroup" aria-label="回退目标阶段">
              {projection.returnTargets.map((target) => (
                <button
                  type="button"
                  key={target.id}
                  role="radio"
                  aria-checked={form.targetStage === target.id}
                  className={`compose-stage-bar__form-target${form.targetStage === target.id ? ' compose-stage-bar__form-target--selected' : ''}`}
                  onClick={() => setForm({ kind: 'return', targetStage: target.id })}
                >
                  {target.label}
                </button>
              ))}
            </div>
          )}
          <input
            className="compose-stage-bar__form-input"
            value={reason}
            placeholder={form.kind === 'skip' ? '填写跳过原因（必填）' : '填写回退原因（必填）'}
            aria-label="原因"
            autoFocus
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submitForm()
              }
            }}
          />
          <div className="compose-stage-bar__form-actions">
            <button type="button" className="compose-stage-bar__form-btn" onClick={closeOverlays}>
              取消
            </button>
            <button
              type="button"
              className="compose-stage-bar__form-btn compose-stage-bar__form-btn--primary"
              disabled={!reason.trim() || submitting}
              onClick={submitForm}
            >
              {submitting ? '提交中…' : form.kind === 'skip' ? '确认跳过' : '确认回退'}
            </button>
          </div>
        </div>
      )}

      {actionError && (
        <div className="compose-stage-bar__error" role="alert">{actionError}</div>
      )}

      {expandedNode && (
        <div className="compose-stage-bar__detail">
          <div className="compose-stage-bar__detail-head">
            <span className="compose-stage-bar__detail-title">
              {expandedNode.label} · {STAGE_STATUS_LABELS[expandedNode.status]}
            </span>
            <button
              type="button"
              className="compose-stage-bar__detail-close"
              aria-label="收起阶段详情"
              onClick={() => setExpandedStageId(null)}
            >
              ×
            </button>
          </div>
          {expandedNode.note && (
            <p className="compose-stage-bar__detail-note">原因：{expandedNode.note}</p>
          )}
          {expandedNode.completedAt && (
            <p className="compose-stage-bar__detail-time">
              完成于 {formatStageTime(expandedNode.completedAt)}
            </p>
          )}
          {expandedNode.id === 'plan' && (
            <div className="compose-stage-bar__plan">
              {planLoading && <span className="compose-stage-bar__plan-hint">正在读取计划…</span>}
              {!planLoading && planDoc && (
                <>
                  <span className="compose-stage-bar__plan-title">{planDoc.title}</span>
                  <span className="compose-stage-bar__plan-path" title={planDoc.path}>{planDoc.path}</span>
                  <button
                    type="button"
                    className="compose-stage-bar__form-btn"
                    onClick={() => void openPlanFile()}
                  >
                    打开计划文件
                  </button>
                </>
              )}
              {!planLoading && !planDoc && !planError && (
                <span className="compose-stage-bar__plan-hint">当前会话暂无计划文件</span>
              )}
              {planError && <span className="compose-stage-bar__plan-error">{planError}</span>}
            </div>
          )}
          {expandedNode.id === 'implement' && (
            <div className="compose-stage-bar__todos">
              {todoState && todoState.todos.length > 0 ? (
                todoState.todos.map((todo, index) => <TodoItemRow key={`${todo.content}-${index}`} todo={todo} />)
              ) : (
                <span className="compose-stage-bar__plan-hint">当前会话暂无任务清单</span>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
