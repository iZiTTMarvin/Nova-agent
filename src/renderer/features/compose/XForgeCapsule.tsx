/**
 * XForge 锻造胶囊：compose 主会话消息区右上的只读进度入口。
 * 阶段表只订阅 useComposeStageStore，回退走既有 compose:apply-stage-transition。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  COMPOSE_STAGE_LABELS,
  createInitialStageTable,
  getComposeStageCursor,
  parseCapabilityItems,
  type ComposeStageId
} from '../../../shared/composeLifecycle'
import type { ActivePlanDocument } from '../../../shared/workspace/types'
import type { TodoItem } from '../../../shared/todo/types'
import type { SubagentActivityProjection } from '../../../shared/subagents'
import { useAgentStore } from '../../stores/useAgentStore'
import { useChatStore } from '../../stores/useChatStore'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'
import { selectSessionTodoState, useTodoStore } from '../todo/useTodoStore'
import { useSubagentProjectionStore } from '../subagents/projection'
import {
  selectSessionComposeStages,
  useComposeStageStore
} from './useComposeStageStore'
import './XForgeCapsule.css'

const RETURNABLE_STAGES: ReadonlySet<ComposeStageId> = new Set(['build', 'inspect', 'deliver'])

const STAGE_GOALS: Record<ComposeStageId, string> = {
  interview: '先问清楚你要什么',
  blueprint: '写成一页纸并请批评者挑刺',
  build: '按清单逐条做出来',
  inspect: '请核验者按一页纸操作验收',
  deliver: '告诉你怎么用、验了什么、没做什么'
}

const ACTIVE_SUBAGENT_STATUSES = new Set([
  'running',
  'queued',
  'retrying',
  'waiting_user'
])

export function shouldShowXForgeCapsule(
  session: { mode: string; kind: string } | null | undefined
): boolean {
  return !!session && session.mode === 'compose' && session.kind !== 'subagent'
}

function collapsedStageLabel(
  currentStageId: ComposeStageId | null,
  isTerminal: boolean,
  stages: { id: ComposeStageId; status: string }[]
): string {
  if (currentStageId) return COMPOSE_STAGE_LABELS[currentStageId]
  if (isTerminal) return COMPOSE_STAGE_LABELS.deliver
  const lastDone = [...stages].reverse().find(
    (entry) => entry.status === 'completed' || entry.status === 'skipped'
  )
  return lastDone ? COMPOSE_STAGE_LABELS[lastDone.id] : COMPOSE_STAGE_LABELS.interview
}

function activityLine(
  running: SubagentActivityProjection | null,
  todos: TodoItem[],
  currentStageId: ComposeStageId | null,
  isTerminal: boolean
): string {
  if (running) {
    const profileId = running.profile.profileId
    if (profileId === 'critic') return '批评者正在挑刺…'
    if (profileId === 'inspector') return '核验者正在操作…'
    return '帮手正在做…'
  }
  const doing = todos.find((todo) => todo.status === 'in_progress')
  if (doing) return `正在做：${doing.content}`
  if (currentStageId) return STAGE_GOALS[currentStageId]
  if (isTerminal) return '锻造完成'
  return STAGE_GOALS.interview
}

function todoCompletesItem(todos: TodoItem[], item: string): boolean {
  const needle = item.trim()
  if (!needle) return false
  return todos.some((todo) => {
    if (todo.status !== 'completed') return false
    const content = todo.content.trim()
    return content === needle || content.includes(needle) || needle.includes(content)
  })
}

interface XForgeCapsuleProps {
  sessionId: string
  interactionLocked: boolean
  isRunning?: boolean
  onRequestSupplement: () => void
}

export const XForgeCapsule: React.FC<XForgeCapsuleProps> = ({
  sessionId,
  interactionLocked,
  isRunning = false,
  onRequestSupplement
}) => {
  const stages = useComposeStageStore((state) => selectSessionComposeStages(state, sessionId))
  const todoState = useTodoStore((state) => selectSessionTodoState(state, sessionId))
  const cancelExecution = useAgentStore((state) => state.cancelExecution)
  const runningSubagent = useSubagentProjectionStore((state) => {
    const ids = state.childRunIdsByParentSessionId[sessionId]
    if (!ids || ids.length === 0) return null
    let latest: SubagentActivityProjection | null = null
    for (const runId of ids) {
      const projection = state.byChildRunId[runId]
      if (!projection || !ACTIVE_SUBAGENT_STATUSES.has(projection.status)) continue
      if (!latest || (projection.startedAt ?? 0) >= (latest.startedAt ?? 0)) {
        latest = projection
      }
    }
    return latest
  })

  const source = stages ?? createInitialStageTable()
  const cursor = getComposeStageCursor(source)
  const stageChar = collapsedStageLabel(cursor.currentStageId, cursor.isTerminal, source)
  const todoTotal = todoState?.total ?? 0
  const collapsedText = todoTotal > 0
    ? `${stageChar} · ${todoState!.completed}/${todoTotal}`
    : stageChar

  const todos = todoState?.todos ?? []
  const activity = activityLine(runningSubagent, todos, cursor.currentStageId, cursor.isTerminal)
  const canReturn =
    !interactionLocked &&
    cursor.currentStageId !== null &&
    RETURNABLE_STAGES.has(cursor.currentStageId)

  const [pinned, setPinned] = useState(false)
  const [hovered, setHovered] = useState(false)
  const expanded = pinned || hovered
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== 'hidden')

  useEffect(() => {
    const updateVisibility = () => setDocumentVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', updateVisibility)
    return () => document.removeEventListener('visibilitychange', updateVisibility)
  }, [])

  const savedPlanCallId = useChatStore(state => {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const message = state.messages[i]
      if (message.sessionId !== sessionId) continue
      const blocks = message.blocks ?? []
      for (let j = blocks.length - 1; j >= 0; j--) {
        const block = blocks[j]
        if (block.type === 'tool' && block.toolName === 'save_plan' && block.status === 'success') return block.toolCallId
      }
    }
    return null
  })
  const [plan, setPlan] = useState<ActivePlanDocument | null>(null)
  const [planLoading, setPlanLoading] = useState(true)
  const [planError, setPlanError] = useState(false)
  const planItems = useMemo(() => parseCapabilityItems(plan?.content ?? ''), [plan])

  useEffect(() => {
    setPinned(false)
    setHovered(false)
    setPlan(null)
  }, [sessionId])

  useEffect(() => {
    if (!expanded) return
    let cancelled = false
    setPlanLoading(true)
    setPlanError(false)
    void window.api.invoke('workspace:read-active-plan', { sessionId })
      .then((doc: ActivePlanDocument | null) => {
        if (cancelled) return
        setPlan(doc)
      })
      .catch(() => {
        if (!cancelled) setPlanError(true)
      })
      .finally(() => { if (!cancelled) setPlanLoading(false) })
    return () => {
      cancelled = true
    }
  }, [expanded, sessionId, savedPlanCallId])

  const checklist = useMemo(() => {
    if (!planItems || planItems.length === 0) return []
    return planItems.map((item) => ({
      text: item,
      done: todoCompletesItem(todos, item)
    }))
  }, [planItems, todos])

  const togglePinned = useCallback(() => {
    setPinned((open) => !open)
  }, [])

  const returnToBlueprint = useCallback(() => {
    if (!canReturn) return
    void window.api.invoke('compose:apply-stage-transition', {
      sessionId,
      action: {
        type: 'return',
        targetStage: 'blueprint',
        reason: '回到方案'
      }
    })
  }, [canReturn, sessionId])

  return (
    <div
      className={`xforge-capsule${expanded ? ' xforge-capsule--expanded' : ''}${pinned ? ' xforge-capsule--pinned' : ''}`}
      aria-label="XForge 锻造"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className="xforge-capsule__chip"
        data-stage={cursor.currentStageId ?? 'deliver'}
        data-running={isRunning && documentVisible && !cursor.isTerminal}
        aria-label={collapsedText}
        aria-expanded={expanded}
        aria-pressed={pinned}
        title={pinned ? '收起进度' : '展开进度'}
        onClick={togglePinned}
      >
        <span className="xforge-capsule__glyph">{stageChar}</span>
        {todoTotal > 0 && <span className="xforge-capsule__count">{` · ${todoState!.completed}/${todoTotal}`}</span>}
      </button>

      {expanded && (
        <div className="xforge-capsule__panel">
          <div className="xforge-capsule__section">
            {planLoading ? (
              <p className="xforge-capsule__hint">正在读取一页纸…</p>
            ) : planError ? (
              <p className="xforge-capsule__hint">读取失败，请收起后重新展开。</p>
            ) : plan && checklist.length === 0 ? (
              <details>
                <summary>{plan.title}（查看计划正文）</summary>
                <div className="xforge-capsule__plan-body">
                  <MarkdownRenderer content={plan.content} />
                </div>
              </details>
            ) : checklist.length === 0 ? (
              <p className="xforge-capsule__hint">暂无一页纸</p>
            ) : (
              <ul className="xforge-capsule__checklist">
                {checklist.map((item) => (
                  <li
                    key={item.text}
                    className={`xforge-capsule__check${item.done ? ' xforge-capsule__check--done' : ''}`}
                    data-checked={item.done ? 'true' : 'false'}
                  >
                    <span className="xforge-capsule__mark" aria-hidden="true">
                      {item.done ? '✓' : '○'}
                    </span>
                    <span>{item.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="xforge-capsule__activity">{activity}</p>

          <div className="xforge-capsule__actions">
            <button
              type="button"
              className="xforge-capsule__btn"
              disabled={!interactionLocked}
              onClick={() => void cancelExecution()}
            >
              暂停
            </button>
            <button
              type="button"
              className="xforge-capsule__btn"
              onClick={onRequestSupplement}
            >
              补充要求
            </button>
            <button
              type="button"
              className="xforge-capsule__btn"
              disabled={!canReturn}
              onClick={returnToBlueprint}
            >
              回到方案
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
