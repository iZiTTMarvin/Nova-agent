import React, { lazy, Suspense, useEffect } from 'react'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { useSubagentProjectionStore, selectLatestSubagentByChildSessionId } from '../subagents/projection'

const SubagentDetail = lazy(() => import('../subagents/SubagentDetailPopover').then(module => ({ default: module.SubagentDetailPopover })))

export function SubagentInspectorView() {
  const target = useLayoutStore(state => state.subagentTarget)
  const close = useLayoutStore(state => state.closeInspector)
  const sessionId = useWorkspaceStore(state => state.currentSessionId)
  const projection = useSubagentProjectionStore(state => target ? selectLatestSubagentByChildSessionId(state, target.childSessionId) : undefined)
  useEffect(() => {
    if (target && target.parentSessionId !== sessionId) close()
  }, [target, sessionId, close])
  if (!target || target.parentSessionId !== sessionId) return null
  return projection ? <Suspense fallback={<div className="inspector-empty">正在读取子会话…</div>}><SubagentDetail surface="inspector" projection={projection} onClose={close} /></Suspense> : <div className="inspector-empty">子会话已不可用<button type="button" onClick={close}>返回</button></div>
}
