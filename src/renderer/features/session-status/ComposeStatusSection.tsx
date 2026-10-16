import React, { useState } from 'react'
import type { ActivePlanDocument } from '../../../shared/workspace/types'
import type { TodoItem } from '../../../shared/todo/types'
import { COMPOSE_STAGE_LABELS, getComposeStageCursor, parseCapabilityItems, type ComposeStageEntry } from '../../../shared/composeLifecycle'
import { useAgentStore } from '../../stores/useAgentStore'

export function ComposeStatusSection({ sessionId, stages, plan, todos, interactionLocked, onRequestSupplement }: {
  sessionId: string
  stages: ComposeStageEntry[]
  plan: ActivePlanDocument | null
  todos: TodoItem[]
  interactionLocked: boolean
  onRequestSupplement: () => void
}) {
  const cursor = getComposeStageCursor(stages)
  const cancelExecution = useAgentStore(state => state.cancelExecution)
  const [error, setError] = useState<string | null>(null)
  const [returning, setReturning] = useState(false)
  const canReturn = !interactionLocked && cursor.currentStageId !== null && ['build', 'inspect', 'deliver'].includes(cursor.currentStageId)
  const capabilities = parseCapabilityItems(plan?.content ?? '')
  const returnToPlan = async () => {
    if (!canReturn || returning) return
    setReturning(true)
    setError(null)
    try {
      await window.api.invoke('compose:apply-stage-transition', { sessionId, action: { type: 'return', targetStage: 'blueprint', reason: '回到方案' } })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setReturning(false) }
  }
  return (
    <section className="session-status__section" aria-label="锻造阶段" data-current-stage={cursor.currentStageId ?? 'deliver'}>
      <div className="session-status__section-title"><span>阶段</span><span>{cursor.isTerminal ? '已交付' : '进行中'}</span></div>
      <ol className="session-status__stages">
        {stages.map(stage => <li key={stage.id} data-stage={stage.id} data-status={stage.status} title={stage.id}><span>{COMPOSE_STAGE_LABELS[stage.id]}</span></li>)}
      </ol>
      {capabilities.length > 0 && (
        <ul className="session-status__capabilities">
          {capabilities.map(item => {
            const text = item.trim()
            const done = todos.some(todo => todo.status === 'completed' && (todo.content.trim() === text || todo.content.includes(text) || text.includes(todo.content.trim())))
            return <li key={item} data-checked={done}><span aria-hidden="true">{done ? '✓' : '○'}</span>{item}</li>
          })}
        </ul>
      )}
      {!plan && <p className="session-status__hint">暂无一页纸</p>}
      <div className="session-status__actions">
        <button type="button" disabled={!interactionLocked} onClick={() => void cancelExecution()}>暂停</button>
        <button type="button" onClick={onRequestSupplement}>补充要求</button>
        <button type="button" disabled={!canReturn || returning} onClick={() => void returnToPlan()}>回到方案</button>
      </div>
      {error && <p className="session-status__error" role="alert">{error}</p>}
    </section>
  )
}
