import { useCallback, useEffect, useRef, useState } from 'react'
import { ScrollIcon, SpinnerIcon } from '../../components/Icons'
import { FloatingStatusWidget } from './FloatingStatusWidget'
import { useLearningStore } from './useLearningStore'
import { KnowledgeNavTree } from './KnowledgeNavTree'
import { LearningConversation } from './LearningConversation'
import { LearningComposer } from './LearningComposer'
import { LearningCheckpointCard } from './LearningCheckpointCard'
import { LearningAssessmentCard } from './LearningAssessmentCard'
import { LearningMaterialPanel } from './LearningMaterialPanel'
import { switchToDevSurface } from './learningSurfaceSwitch'
import { useChatStore } from '../../stores/useChatStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { selectSessionIsRunning, useRunStore } from '../../stores/useRunStore'
import { isTerminalRunStatus } from '../../../shared/run/types'
import { getDistanceFromBottom, scrollContainerToBottom } from '../chat/autoScroll'
import './LearningSurface.css'

export function LearningSurface({ sessionId }: { sessionId: string }): React.ReactElement {
  const rootRef = useRef<HTMLDivElement>(null)
  const readingRef = useRef<HTMLDivElement>(null)
  const [buildConfirm, setBuildConfirm] = useState(false)
  const [buildError, setBuildError] = useState<string | null>(null)
  const projection = useLearningStore(state => state.sessionId === sessionId ? state.projection : null)
  const status = useLearningStore(state => state.status)
  const error = useLearningStore(state => state.error)
  const material = useLearningStore(state => state.sessionId === sessionId ? state.material : null)
  const commandPending = useLearningStore(state => state.sessionId === sessionId && state.commandPending)
  const refresh = useLearningStore(state => state.refresh)
  const openNodeMaterial = useLearningStore(state => state.openNodeMaterial)
  const closeMaterial = useLearningStore(state => state.closeMaterial)
  const sendCommand = useLearningStore(state => state.sendCommand)
  const clearForSession = useLearningStore(state => state.clearForSession)
  const currentGeneratingMessageId = useChatStore(state => state.currentGeneratingMessageId)
  const sessions = useChatStore(state => state.sessions)
  // 仅在 chat store 当前聚焦会话与本表面 sessionId 匹配时才渲染消息，杜绝跨会话切面水合间隙展示脏数据
  const messages = useChatStore(state => state.currentSessionId === sessionId ? state.messages : [])
  const requestComposerPrefill = useSettingsStore(state => state.requestComposerPrefill)
  const isGenerating = useRunStore(state => selectSessionIsRunning(state, sessionId))

  useEffect(() => {
    const unsubChanged = window.api.on('learning:surface-changed', data => {
      const current = useLearningStore.getState().projection
      if (data.sessionId === sessionId || data.workspaceRoot === current?.workspaceRoot) void refresh(sessionId)
    })
    const unsubSnapshot = window.api.on('run:snapshot', data => {
      if (data.snapshot.sessionId === sessionId && isTerminalRunStatus(data.snapshot.status)) void refresh(sessionId)
    })
    clearForSession(sessionId)
    void refresh(sessionId)
    setBuildError(null)
    setBuildConfirm(false)
    return () => {
      unsubChanged()
      unsubSnapshot()
      clearForSession(null)
    }
  }, [sessionId, clearForSession, refresh])

  useEffect(() => {
    if (sessions.length > 0) useLearningStore.getState().pruneDrafts(sessions.map(session => session.id))
  }, [sessions])

  const handleSelectNode = useCallback((nodeId: string) => {
    void sendCommand({ sessionId, action: { type: 'select_node', nodeId } })
    void openNodeMaterial(sessionId, nodeId)
  }, [openNodeMaterial, sendCommand, sessionId])

  const handleEditInDev = useCallback((nodeId: string, nodeTitle: string, filePath: string | null) => {
    const location = filePath ? `\n源码出处：${filePath}` : ''
    requestComposerPrefill(`围绕「${nodeTitle}」改动实现${location}\n学习节点：${nodeId}\n我的改动意图：`)
    void switchToDevSurface()
  }, [requestComposerPrefill])

  const build = async () => {
    setBuildConfirm(false)
    setBuildError(null)
    try {
      await window.api.invoke('learning:build', { sessionId })
    } catch (failure) {
      if (useLearningStore.getState().sessionId === sessionId) setBuildError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      void refresh(sessionId)
    }
  }

  const busy = isGenerating || commandPending
  const summary = projection?.summary
  const selected = projection?.tree.nodes.find(node => node.nodeId === projection.selectedNodeId)
  const nodeCount = projection?.tree.nodes.length ?? 0
  const isBuilding = projection?.build.status === 'running'

  const capsuleContent = (
    <span className="learning-status-capsule">
      {isBuilding ? (
        <SpinnerIcon size={13} className="learning-status-capsule__spin" />
      ) : (
        <ScrollIcon size={14} className="learning-status-capsule__icon" />
      )}
      <span className="learning-status-capsule__label">项目知识</span>
      <span className="learning-status-capsule__meta">
        {isBuilding
          ? '整理中…'
          : nodeCount > 0
            ? `${nodeCount} 个主题`
            : '待整理'}
      </span>
      {isBuilding ? (
        <span className="learning-status-capsule__dot learning-status-capsule__dot--pulse" />
      ) : nodeCount > 0 ? (
        <span className="learning-status-capsule__dot learning-status-capsule__dot--ready" />
      ) : null}
    </span>
  )

  const statusBadge = projection?.tree.knowledgeRevision
    ? `R${projection.tree.knowledgeRevision}`
    : nodeCount > 0
      ? `${nodeCount} 主题`
      : undefined

  // 核对点卡片或评估反馈出现时，若在底部附近则自动平滑跟随
  useEffect(() => {
    const el = readingRef.current
    if (!el) return
    if (getDistanceFromBottom(el) <= 120) {
      scrollContainerToBottom(el, 'smooth')
    }
  }, [projection?.checkpoint?.checkpointId, projection?.latestAssessment?.assessmentId])

  return <div className="learning-surface" ref={rootRef} data-has-material={Boolean(material)}>
    <header className="learning-surface__bar">
      <div className="learning-surface__heading">
        <span className="learning-surface__title">{selected?.title ?? '项目学习'}</span>
        {summary && (summary.independentCount > 0 || summary.needsClarificationCount > 0 || summary.pendingReviewNodeCount > 0) &&
          <span className="learning-surface__summary">理解记录 {summary.independentCount} · 待澄清 {summary.needsClarificationCount} · 待复核 {summary.pendingReviewNodeCount}</span>}
      </div>
    </header>
    {status === 'error' && <div className="learning-surface__error" role="alert">学习状态加载失败：{error}
      <button type="button" onClick={() => void refresh(sessionId)}>重试</button></div>}
    <div className="learning-surface__body">
      <main className="learning-surface__main">
        <FloatingStatusWidget
          capsule={capsuleContent}
          title="项目知识"
          badge={statusBadge}
          cardAriaLabel="项目知识面板"
          capsuleAriaLabel="展开项目知识面板"
        >
          <div className="learning-surface__status-body">
            {projection ? (
              <KnowledgeNavTree
                tree={projection.tree}
                selectedNodeId={projection.selectedNodeId}
                nodeProgress={projection.nodeProgress}
                disabled={busy}
                onSelectNode={handleSelectNode}
              />
            ) : (
              <p role="status" className="learning-surface__status-loading">正在读取学习记录…</p>
            )}
            <div className="learning-build">
              {isBuilding ? (
                <>
                  <p role="status">正在整理项目知识…</p>
                  <button type="button" onClick={() => void window.api.invoke('learning:cancel-build', { sessionId })}>取消整理</button>
                </>
              ) : (
                <button type="button" disabled={busy} onClick={() => setBuildConfirm(value => !value)}>
                  {projection?.tree.knowledgeRevision ? '重新整理教材' : '整理项目知识'}
                </button>
              )}
              {buildConfirm && (
                <div className="learning-build__confirm">
                  <p>将选取少量项目源码发送给当前模型，最多调用两次，可能产生费用。不会修改代码，可随时取消。</p>
                  <button type="button" onClick={() => void build()}>开始整理</button>
                  <button type="button" onClick={() => setBuildConfirm(false)}>暂不整理</button>
                </div>
              )}
              {(buildError || projection?.build.status === 'failed') && (
                <p role="alert">{buildError ?? (projection?.build.status === 'failed' ? projection.build.message : '')}</p>
              )}
              {projection?.build.status === 'cancelled' && <p role="status">整理已停止，已保存的教材不受影响。</p>}
            </div>
          </div>
        </FloatingStatusWidget>
        <div className="learning-surface__reading" ref={readingRef}>
          <LearningConversation messages={messages} isGenerating={isGenerating}
            currentGeneratingMessageId={currentGeneratingMessageId} sessionId={sessionId}
            scrollContainerRef={readingRef} />
          {projection?.checkpoint && <LearningCheckpointCard sessionId={sessionId} checkpoint={projection.checkpoint} disabled={busy} />}
          {projection?.latestAssessment && <LearningAssessmentCard sessionId={sessionId} assessment={projection.latestAssessment} disabled={busy} />}
        </div>
        <LearningComposer sessionId={sessionId} projection={projection} isGenerating={isGenerating} disabled={busy || !projection} />
      </main>
      {material && <LearningMaterialPanel key={`${sessionId}:${material.nodeId}`} sessionId={sessionId} state={material}
        onClose={closeMaterial} onEditInDev={handleEditInDev} />}
    </div>
  </div>
}
