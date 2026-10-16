import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { shallow } from 'zustand/shallow'
import type { ActivePlanDocument } from '../../../shared/workspace/types'
import type { Mode } from '../../../shared/session/types'
import { COMPOSE_STAGE_LABELS, createInitialStageTable, getComposeStageCursor } from '../../../shared/composeLifecycle'
import { CheckIcon, ChevronIcon, CodeIcon, PlanIcon } from '../../components/Icons'
import { useChatStore } from '../../stores/useChatStore'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { useRunStore, selectSessionIsRunning, selectSessionSnapshot } from '../../stores/useRunStore'
import { selectSessionTodoState, useTodoStore } from '../todo/useTodoStore'
import { useComposeStageStore, selectSessionComposeStages } from '../compose/useComposeStageStore'
import { useSubagentProjectionStore, selectActiveBackgroundSubagentsByParentSessionId } from '../subagents/projection'
import { ComposeStatusSection } from './ComposeStatusSection'
import { StatusSprite } from './StatusSprite'
import { findStatusPlan } from './statusModel'
import { useSessionChanges } from './useSessionChanges'
import './SessionStatusPanel.css'

/** ZCode 风格对角内收图标：表达「将悬浮卡片收回到顶栏按钮」而非删除 */
function CollapseCardIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 2v4h4M14 2l-4 4M6 14v-4H2M2 14l4-4" />
    </svg>
  )
}

export function SessionStatusPanel({ sessionId, mode, onRequestSupplement, surface = 'rail' }: { sessionId: string; mode: Mode; onRequestSupplement: () => void; surface?: 'rail' | 'inspector' }) {
  const railRef = useRef<HTMLElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inspectorOpen = useLayoutStore(state => state.inspectorOpen)
  const inspectorSurface = useLayoutStore(state => state.inspectorSurface)
  const openReview = useLayoutStore(state => state.openReview)
  const openPlan = useLayoutStore(state => state.openPlan)
  const openSubagent = useLayoutStore(state => state.openSubagent)
  const openStatus = useLayoutStore(state => state.openStatus)
  const closeInspector = useLayoutStore(state => state.closeInspector)
  const todoState = useTodoStore(state => selectSessionTodoState(state, sessionId))
  const stages = useComposeStageStore(state => selectSessionComposeStages(state, sessionId))
  const background = useSubagentProjectionStore(state => selectActiveBackgroundSubagentsByParentSessionId(state, sessionId), shallow)
  const savedPlan = useChatStore(state => findStatusPlan(state.messages, sessionId), shallow)
  const running = useRunStore(state => selectSessionIsRunning(state, sessionId))
  const sendInFlight = useChatStore(state => state.sendInFlight && state.currentSessionId === sessionId)
  const waiting = useRunStore(state => selectSessionSnapshot(state, sessionId)?.status === 'waiting_user')
  const { turns, failedIds, retryLoad } = useSessionChanges(sessionId)
  const hasMore = useChatStore(state => state.hasMoreMessagesAbove)
  const loadingOlder = useChatStore(state => state.isLoadingOlderMessages)
  const loadOlder = useChatStore(state => state.loadOlderMessages)
  const [plan, setPlan] = useState<ActivePlanDocument | null>(null)
  const [planLoading, setPlanLoading] = useState(true)
  const [planError, setPlanError] = useState<string | null>(null)
  const [planRetry, setPlanRetry] = useState(0)
  const [wantsExpanded, setWantsExpanded] = useState(true)
  const [manualEmptyOpen, setManualEmptyOpen] = useState(false)
  const [wide, setWide] = useState(true)
  const [bodyHeight, setBodyHeight] = useState(0)
  const [awake, setAwake] = useState(0)
  const [allTasks, setAllTasks] = useState(false)
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== 'hidden')
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null)
  const isCompose = mode === 'compose'
  const stageTable = useMemo(() => stages ?? createInitialStageTable(), [stages])
  const cursor = getComposeStageCursor(stageTable)
  const stageLabel = cursor.currentStageId ? COMPOSE_STAGE_LABELS[cursor.currentStageId] : '交'
  const total = todoState?.total ?? 0
  const completed = todoState?.completed ?? 0
  const complete = total > 0 && todoState!.todos.every(todo => todo.status === 'completed')
  const selectedTurn = turns[0]
  const hasContent = isCompose || total > 0 || !!plan || turns.length > 0 || background.length > 0 || failedIds.length > 0 || !!planError
  const expanded = surface === 'inspector' || (wantsExpanded && wide && !inspectorOpen && (hasContent || manualEmptyOpen))
  const tiny = surface !== 'inspector' && (!wide || inspectorOpen)
  const visible = surface === 'inspector' || hasContent || manualEmptyOpen
  const hasOtherSections = isCompose || !!plan || !!planError || !!selectedTurn || failedIds.length > 0 || background.length > 0
  const isRunningSprite = ((running && !waiting) || background.length > 0) && documentVisible
  const headline = total > 0
    ? '进程'
    : background.length > 0
      ? '后台任务'
      : isCompose
        ? (expanded ? '锻造阶段' : stageLabel)
        : selectedTurn
          ? `${selectedTurn.files.length} 个文件改动`
          : plan
            ? '计划已就绪'
            : '会话状态'

  useEffect(() => {
    let active = true
    setPlanLoading(true)
    setPlanError(null)
    void window.api.invoke('workspace:read-active-plan', { sessionId }).then(document => {
      if (active) setPlan(document)
    }).catch(reason => {
      if (active) setPlanError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (active) setPlanLoading(false) })
    return () => { active = false }
  }, [sessionId, savedPlan?.toolCallId, planRetry])

  useEffect(() => {
    const update = () => setDocumentVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  // 胶囊按钮常驻于顶部栏右侧固定槽位（对标 MiniMax 顶栏控制组），聊天区内不再挂收起态悬浮小胶囊。
  useLayoutEffect(() => {
    if (surface !== 'rail') return
    const target = document.querySelector<HTMLElement>('.glass-header__status-slot')
      ?? document.querySelector<HTMLElement>('.glass-header__right')
    if (!target) return
    const slot = document.createElement('div')
    slot.style.display = 'contents'
    target.insertBefore(slot, target.firstChild)
    setHeaderSlot(slot)
    return () => {
      slot.remove()
      setHeaderSlot(null)
    }
  }, [surface])

  // 前置已完成项超长时自动折叠为「已完成 N 项」，仅露出末尾最近/进行中项（对标 ZCode 15/15 折叠体验）
  const { foldedDoneCount, visibleTasks, indexOffset } = useMemo(() => {
    const list = todoState?.todos ?? []
    if (list.length <= 4) {
      return { foldedDoneCount: 0, visibleTasks: list, indexOffset: 0 }
    }
    let leadingDone = 0
    while (
      leadingDone < list.length - 3 &&
      (list[leadingDone]?.status === 'completed' || list[leadingDone]?.status === 'cancelled')
    ) {
      leadingDone++
    }
    if (leadingDone >= 2) {
      if (allTasks) {
        return { foldedDoneCount: leadingDone, visibleTasks: list, indexOffset: 0 }
      }
      return {
        foldedDoneCount: leadingDone,
        visibleTasks: list.slice(leadingDone),
        indexOffset: leadingDone
      }
    }
    if (allTasks || list.length <= 6) {
      return { foldedDoneCount: 0, visibleTasks: list, indexOffset: 0 }
    }
    return {
      foldedDoneCount: 0,
      visibleTasks: todoState?.view.todos ?? list.slice(0, 6),
      indexOffset: todoState?.view.hiddenBefore ?? 0
    }
  }, [todoState, allTasks])

  useLayoutEffect(() => {
    const rail = railRef.current
    const body = bodyRef.current
    if (!rail || !body) return
    const measure = () => {
      setWide(getComputedStyle(rail).getPropertyValue('--status-wide').trim() === '1')
      setBodyHeight(body.scrollHeight)
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (rail.parentElement) observer.observe(rail.parentElement)
    observer.observe(body)
    return () => observer.disconnect()
  }, [visible, allTasks, total, turns.length, background.length, !!plan, isCompose])

  // 只有领域内容变更才激活；流式正文、审阅标记和窗口缩放不重新弹开。
  const updateKey = JSON.stringify([
    todoState?.todos.map(todo => [todo.content, todo.status]),
    isCompose ? stageTable.map(stage => stage.status) : null,
    plan?.updatedAt,
    turns[0]?.messageId, turns[0]?.cache ? [turns[0].added, turns[0].removed] : null,
    background.map(agent => [agent.childRunId, agent.status])
  ])
  const previousUpdate = useRef(updateKey)
  useEffect(() => {
    if (previousUpdate.current !== updateKey) {
      previousUpdate.current = updateKey
      setWantsExpanded(true)
      setAwake(value => value + 1)
    }
  }, [updateKey])

  useEffect(() => {
    if (!expanded || surface === 'inspector') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      setWantsExpanded(false)
      setManualEmptyOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [expanded, surface])

  const openChanges = (filePath?: string) => {
    if (selectedTurn) openReview({ messageId: selectedTurn.messageId, ...(filePath ? { filePath } : {}) })
  }
  const collapseFloating = () => {
    if (surface === 'inspector') {
      closeInspector()
    } else {
      setWantsExpanded(false)
      setManualEmptyOpen(false)
      triggerRef.current?.focus()
    }
  }
  const toggle = () => {
    if (!hasContent) {
      if (!wide || inspectorOpen) {
        if (inspectorOpen && inspectorSurface === 'status') closeInspector()
        else openStatus(sessionId)
      } else {
        setManualEmptyOpen(value => {
          const next = !value
          if (next) setWantsExpanded(true)
          return next
        })
      }
      return
    }
    if (inspectorOpen && !wide && surface === 'rail' && useLayoutStore.getState().inspectorSurface !== 'status') {
      openStatus(sessionId)
    } else if (inspectorOpen) {
      closeInspector()
      if (useLayoutStore.getState().inspectorOpen) closeInspector()
      setWantsExpanded(true)
    } else if (!wide) {
      if (background[0]) openSubagent({ parentSessionId: sessionId, childSessionId: background[0].childSessionId })
      else if (selectedTurn) openChanges()
      else openStatus(sessionId)
    } else {
      setWantsExpanded(value => !value)
    }
  }

  const topbarActive = expanded || (inspectorOpen && inspectorSurface === 'status')

  return (
    <>
      {surface === 'rail' && headerSlot && createPortal(
        <button
          ref={triggerRef}
          type="button"
          className="session-status__topbar-capsule"
          data-active={topbarActive}
          data-has-content={hasContent}
          data-complete={complete}
          aria-label={expanded ? '收起会话状态' : '查看会话状态'}
          aria-expanded={topbarActive}
          onClick={toggle}
          title={headline}
        >
          <StatusSprite awake={awake} running={isRunningSprite} complete={complete} />
          {hasContent && <span className="session-status__topbar-text">{headline}</span>}
          {total > 0 && (
            <span className="session-status__count" data-complete={complete}>
              {completed}/{total}
            </span>
          )}
        </button>,
        headerSlot
      )}
      <aside
        ref={railRef}
        className={`session-status-rail${surface === 'inspector' ? ' session-status-rail--inspector' : ''}`}
        data-inspector={inspectorOpen}
        data-empty={!hasContent}
        data-expanded={expanded}
        data-topbar-hosted={Boolean(headerSlot)}
        aria-label={surface === 'inspector' ? '会话状态详情' : '对话右侧状态区'}
      >
        {visible && (
          <div
            className="session-status"
            data-expanded={expanded}
            data-tiny={tiny}
            data-complete={complete}
            style={{ '--status-body-height': `${Math.min(bodyHeight, 490)}px` } as React.CSSProperties}
          >
            <div className="session-status__header">
              <button
                ref={headerSlot ? undefined : triggerRef}
                type="button"
                className="session-status__trigger"
                aria-label={expanded ? '收起会话状态' : '查看会话状态'}
                aria-expanded={expanded}
                onClick={toggle}
                title={headline}
              >
                <StatusSprite awake={awake} running={isRunningSprite} complete={complete} />
                <span className="session-status__headline">{headline}</span>
                {total > 0 && (
                  <span className="session-status__count" data-complete={complete}>
                    {completed}/{total}
                  </span>
                )}
              </button>
              <button
                type="button"
                className="session-status__collapse"
                aria-label="收起浮窗"
                title="收起浮窗"
                onClick={collapseFloating}
              >
                <CollapseCardIcon />
              </button>
            </div>
            <div className="session-status__viewport" inert={!expanded} aria-hidden={!expanded}>
              <div ref={bodyRef} className="session-status__body">
                {isCompose && (
                  <ComposeStatusSection
                    sessionId={sessionId}
                    stages={stageTable}
                    plan={plan}
                    todos={todoState?.todos ?? []}
                    interactionLocked={running || sendInFlight || waiting}
                    onRequestSupplement={onRequestSupplement}
                  />
                )}
                {plan && (
                  <section className="session-status__section" aria-label="计划文档">
                    <div className="session-status__section-title">计划</div>
                    <button type="button" className="session-status__link" onClick={() => openPlan(savedPlan ?? { sessionId })}>
                      <PlanIcon size={15} />
                      <span>{plan.title}</span>
                      <ChevronIcon size={13} direction="right" />
                    </button>
                  </section>
                )}
                {planError && (
                  <div className="session-status__error" role="alert">
                    计划读取失败
                    <button type="button" onClick={() => setPlanRetry(value => value + 1)}>重试</button>
                  </div>
                )}
                {total > 0 && (
                  <section className="session-status__section" aria-label="任务清单">
                    {hasOtherSections ? (
                      <div className="session-status__section-title">
                        <span>进度</span>
                        <span className="session-status__count" data-complete={complete}>{completed}/{total}</span>
                      </div>
                    ) : (
                      <span className="session-status__sr-only">{completed}/{total}</span>
                    )}
                    {foldedDoneCount > 0 && (
                      <button
                        type="button"
                        className="session-status__fold-toggle"
                        aria-expanded={allTasks}
                        onClick={() => setAllTasks(value => !value)}
                      >
                        <ChevronIcon size={12} direction={allTasks ? 'down' : 'right'} />
                        <span>已完成 {foldedDoneCount} 项</span>
                      </button>
                    )}
                    <ul className="session-status__tasks">
                      {visibleTasks.map((todo, index) => (
                        <li key={indexOffset + index} data-status={todo.status}>
                          <span
                            className="session-status__task-mark"
                            aria-label={
                              todo.status === 'completed'
                                ? '已完成'
                                : todo.status === 'cancelled'
                                  ? '已取消'
                                  : todo.status === 'in_progress'
                                    ? '进行中'
                                    : '待处理'
                            }
                          >
                            {todo.status === 'completed' ? <CheckIcon size={11} /> : todo.status === 'cancelled' ? '−' : null}
                          </span>
                          <span className="session-status__task-text">{todo.content}</span>
                        </li>
                      ))}
                    </ul>
                    {foldedDoneCount === 0 && total > 6 && (
                      <button type="button" className="session-status__more" onClick={() => setAllTasks(value => !value)}>
                        {allTasks ? '只看当前任务' : `查看全部 ${total} 项任务`}
                      </button>
                    )}
                  </section>
                )}
                {selectedTurn && (
                  <section className="session-status__section" aria-label="文件改动">
                    <div className="session-status__section-title">
                      <span>交付物 <span>{selectedTurn.files.length}</span></span>
                      {selectedTurn.cache && (
                        <span className="session-status__stats">
                          <span>+{selectedTurn.added}</span>
                          <span>−{selectedTurn.removed}</span>
                        </span>
                      )}
                    </div>
                    {selectedTurn.files.slice(0, 3).map(file => (
                      <button
                        type="button"
                        key={file.filePath}
                        className="session-status__link"
                        title={file.filePath}
                        onClick={() => openChanges(file.filePath)}
                      >
                        <CodeIcon size={14} />
                        <span>{file.filePath.split(/[\\/]/).at(-1)}</span>
                        <span className="session-status__file-status">
                          {file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M'}
                        </span>
                      </button>
                    ))}
                    {selectedTurn.files.length > 3 && (
                      <span className="session-status__hint">另有 {selectedTurn.files.length - 3} 个文件</span>
                    )}
                    {!!selectedTurn.cache?.skippedFiles?.length && (
                      <p className="session-status__hint">{selectedTurn.cache.skippedFiles.length} 个文件未生成快照，无法回退</p>
                    )}
                    <button type="button" className="session-status__link session-status__review-entry" onClick={() => openChanges()}>
                      <span>{selectedTurn.cache ? '审阅这轮改动' : '正在读取差异…'}</span>
                      <ChevronIcon size={13} direction="right" />
                    </button>
                  </section>
                )}
                {failedIds.length > 0 && (
                  <p className="session-status__error" role="alert">
                    部分轮次差异未能读取
                    <button type="button" onClick={retryLoad}>重试</button>
                  </p>
                )}
                {hasMore && (
                  <button type="button" className="session-status__more" disabled={loadingOlder} onClick={() => void loadOlder()}>
                    {loadingOlder ? '读取更早记录…' : '查看更早改动'}
                  </button>
                )}
                {background.length > 0 && (
                  <section className="session-status__section" aria-label="后台任务">
                    <div className="session-status__section-title">
                      <span>后台</span>
                      <span>{background.length} 个运行中</span>
                    </div>
                    {background.map(agent => (
                      <button
                        key={agent.childRunId}
                        type="button"
                        className="session-status__link session-status__agent"
                        onClick={() => openSubagent({ parentSessionId: sessionId, childSessionId: agent.childSessionId })}
                        aria-label={`查看${agent.profile.name}子会话`}
                      >
                        <span className="session-status__agent-dot" />
                        <span>
                          {agent.profile.name}
                          <small>{agent.taskLabel}</small>
                        </span>
                        <ChevronIcon size={13} direction="right" />
                      </button>
                    ))}
                  </section>
                )}
                {!hasContent && (
                  <p className="session-status__hint">{planLoading ? '正在读取会话状态…' : '暂无任务或改动'}</p>
                )}
              </div>
            </div>
          </div>
        )}
      </aside>
    </>
  )
}
