import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { useChatStore } from '../../stores/useChatStore'
import { useAgentStore } from '../../stores/useAgentStore'
import {
  selectLatestSubagentByChildSessionId,
  useSubagentProjectionStore
} from './projection'
import { requestSubagentResume } from './resumeSubagentExecution'
import './SubagentSessionHeader.css'

type ResumeState = 'idle' | 'submitting' | 'waiting' | 'started' | 'failed'

export const SubagentSessionHeader: React.FC<{ originalTask?: string | null }> = ({
  originalTask
}) => {
  const sessions = useChatStore((state) => state.sessions)
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const selectSession = useChatStore((state) => state.selectSession)
  const cancelExecution = useAgentStore((state) => state.cancelExecution)

  const projection = useSubagentProjectionStore((state) =>
    currentSessionId ? selectLatestSubagentByChildSessionId(state, currentSessionId) : undefined
  )

  const [resumeState, setResumeState] = useState<ResumeState>('idle')
  const [resumeRejection, setResumeRejection] = useState<string>('')
  const unsubscribeRef = useRef<(() => void) | null>(null)

  const childSessionId = currentSessionId ?? ''
  const parentSessionId = projection?.parentSessionId ?? ''
  const childRunId = projection?.childRunId ?? ''

  const subscribeResumed = useCallback(() => {
    if (!childRunId) return
    unsubscribeRef.current?.()
    const unsub = useSubagentProjectionStore.subscribe((state) => {
      // 续跑产生新 childRunId，通过 resumedFromRunId 反向定位旧 run 的接替者
      const updated = Object.values(state.byChildRunId).find(
        item => item.resumedFromRunId === childRunId && item.status !== 'interrupted'
      )
      if (updated) setResumeState('started')
    })
    unsubscribeRef.current = unsub
  }, [childRunId])

  useEffect(() => {
    return () => unsubscribeRef.current?.()
  }, [])

  const handleResume = useCallback(async () => {
    if (!parentSessionId || !childSessionId || !childRunId) return
    setResumeState('submitting')
    setResumeRejection('')
    const result = await requestSubagentResume({
      parentSessionId,
      childSessionId,
      childRunId
    })
    if (result.ok) {
      setResumeState('waiting')
      subscribeResumed()
    } else {
      setResumeState('failed')
      setResumeRejection(result.rejection ?? '提交失败')
    }
  }, [parentSessionId, childSessionId, childRunId, subscribeResumed])

  const session = sessions.find((candidate) => candidate.id === currentSessionId)
  if (!session || session.kind !== 'subagent') return null

  const active = projection && ![
    'completed',
    'failed',
    'cancelled',
    'interrupted',
    'record_missing'
  ].includes(projection.status)

  const showResume =
    projection?.status === 'interrupted' &&
    resumeState === 'idle'

  return (
    <header className="subagent-session-header">
      <Button
        label="← 返回父任务"
        variant="ghost"
        size="sm"
        className="subagent-session-header__back"
        onClick={() => void selectSession(session.subagent.lineage.parentSessionId)}
      />
      <div className="subagent-session-header__identity">
        <span className="subagent-session-header__name">{session.subagent.profile.name}</span>
        <span className="subagent-session-header__permission">
          {session.subagent.profile.permissionCeiling === 'read_only' ? '只读' : '工作区写入'}
        </span>
      </div>
      {originalTask ? (
        <p className="subagent-session-header__task" title={originalTask}>{originalTask}</p>
      ) : null}
      {active ? (
        <Button
          label="停止"
          aria-label={`停止子代理 ${session.subagent.profile.name}`}
          variant="destructive"
          size="sm"
          className="subagent-session-header__stop"
          onClick={() => void cancelExecution(projection.childRunId)}
        />
      ) : null}
      {showResume ? (
        <Button
          label="继续此子任务"
          aria-label="继续此子任务"
          variant="primary"
          size="sm"
          onClick={handleResume}
        />
      ) : null}
      {resumeState === 'submitting' ? (
        <Button
          label="提交中…"
          variant="primary"
          isDisabled={true}
        />
      ) : null}
      {resumeState === 'waiting' ? (
        <span className="subagent-session-header__resume-waiting">已提交，等待父会话处理</span>
      ) : null}
      {resumeState === 'failed' ? (
        <Button
          label={`重试${resumeRejection ? ` (${resumeRejection})` : ''}`}
          variant="destructive"
          size="sm"
          onClick={handleResume}
        />
      ) : null}
      {resumeState === 'started' ? (
        <span className="subagent-session-header__resume-started">已开始</span>
      ) : null}
    </header>
  )
}
