import { useCallback, useEffect, useRef, useState } from 'react'
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
import './LearningSurface.css'

export function LearningSurface({ sessionId }: { sessionId: string }): React.ReactElement {
  const rootRef = useRef<HTMLDivElement>(null)
  const readingRef = useRef<HTMLDivElement>(null)
  const navButtonRef = useRef<HTMLButtonElement>(null)
  const returnButtonRef = useRef<HTMLButtonElement>(null)
  const [compact, setCompact] = useState(true)
  const [navOpen, setNavOpen] = useState(false)
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
  const messages = useChatStore(state => state.messages)
  const sessions = useChatStore(state => state.sessions)
  const requestComposerPrefill = useSettingsStore(state => state.requestComposerPrefill)
  const isGenerating = useRunStore(state => selectSessionIsRunning(state, sessionId))

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const observer = new ResizeObserver(() => setCompact(root.clientWidth < 760))
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

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
    if (compact) setNavOpen(false)
  }, [openNodeMaterial, sendCommand, sessionId, compact])

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
  const navVisible = !compact || navOpen
  const summary = projection?.summary
  const selected = projection?.tree.nodes.find(node => node.nodeId === projection.selectedNodeId)
  return <div className="learning-surface" ref={rootRef}>
    <header className="learning-surface__bar">
      <button ref={navButtonRef} type="button" className="learning-surface__nav-toggle" aria-expanded={navVisible}
        aria-controls="learning-navigation" onClick={() => setNavOpen(value => !value)}>知识导航</button>
      <div className="learning-surface__heading"><span className="learning-surface__title">{selected?.title ?? '项目学习'}</span>
        {summary && (summary.independentCount > 0 || summary.needsClarificationCount > 0 || summary.pendingReviewNodeCount > 0) &&
          <span className="learning-surface__summary">理解记录 {summary.independentCount} · 待澄清 {summary.needsClarificationCount} · 待复核 {summary.pendingReviewNodeCount}</span>}
      </div>
      <button ref={returnButtonRef} type="button" className="learning-surface__return" onClick={() => void switchToDevSurface()}>返回开发</button>
    </header>
    {status === 'error' && <div className="learning-surface__error" role="alert">学习状态加载失败：{error}
      <button type="button" onClick={() => void refresh(sessionId)}>重试</button></div>}
    <div className="learning-surface__body">
      <nav id="learning-navigation" className="learning-surface__nav" aria-label="知识导航" hidden={!navVisible}
        onKeyDown={event => { if (event.key === 'Escape' && compact) { setNavOpen(false); navButtonRef.current?.focus() } }}>
        <div className="learning-surface__nav-head"><h2>项目知识</h2>{compact && <button type="button" onClick={() => { setNavOpen(false); navButtonRef.current?.focus() }}>收起</button>}</div>
        {projection ? <KnowledgeNavTree tree={projection.tree} selectedNodeId={projection.selectedNodeId}
          nodeProgress={projection.nodeProgress} disabled={busy} onSelectNode={handleSelectNode} /> : <p role="status">正在读取学习记录…</p>}
        <div className="learning-build">
          {projection?.build.status === 'running'
            ? <><p role="status">正在整理项目知识…</p><button type="button" onClick={() => void window.api.invoke('learning:cancel-build', { sessionId })}>取消整理</button></>
            : <button type="button" disabled={busy} onClick={() => setBuildConfirm(value => !value)}>{projection?.tree.knowledgeRevision ? '重新整理教材' : '整理项目知识'}</button>}
          {buildConfirm && <div className="learning-build__confirm"><p>将选取少量项目源码发送给当前模型，最多调用两次，可能产生费用。不会修改代码，可随时取消。</p><button type="button" onClick={() => void build()}>开始整理</button><button type="button" onClick={() => setBuildConfirm(false)}>暂不整理</button></div>}
          {(buildError || projection?.build.status === 'failed') && <p role="alert">{buildError ?? (projection?.build.status === 'failed' ? projection.build.message : '')}</p>}
          {projection?.build.status === 'cancelled' && <p role="status">整理已停止，已保存的教材不受影响。</p>}
        </div>
      </nav>
      <main className="learning-surface__main">
        <div className="learning-surface__reading" ref={readingRef}>
          <LearningConversation messages={messages} isGenerating={isGenerating} scrollContainerRef={readingRef} />
          {projection?.checkpoint && <LearningCheckpointCard sessionId={sessionId} checkpoint={projection.checkpoint} disabled={busy} />}
          {projection?.latestAssessment && <LearningAssessmentCard sessionId={sessionId} assessment={projection.latestAssessment} disabled={busy} />}
        </div>
        <LearningComposer sessionId={sessionId} projection={projection} isGenerating={isGenerating} disabled={busy || !projection} />
      </main>
      {material && <LearningMaterialPanel key={`${sessionId}:${material.nodeId}`} sessionId={sessionId} state={material}
        onClose={() => {
          closeMaterial()
          // 导航按钮仅在 compact 覆盖模式下可见；宽窗口关闭时焦点回到常驻的返回开发按钮
          if (navVisible) navButtonRef.current?.focus()
          else returnButtonRef.current?.focus()
        }} onEditInDev={handleEditInDev} />}
    </div>
  </div>
}
