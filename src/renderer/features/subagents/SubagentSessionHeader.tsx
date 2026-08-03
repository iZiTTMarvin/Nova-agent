import React from 'react'
import { Button } from '@astryxdesign/core/Button'
import { useChatStore } from '../../stores/useChatStore'
import { useAgentStore } from '../../stores/useAgentStore'
import { useSubagentProjectionStore } from './projection'
import './SubagentSessionHeader.css'

export const SubagentSessionHeader: React.FC<{ originalTask?: string | null }> = ({
  originalTask
}) => {
  const sessions = useChatStore((state) => state.sessions)
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const selectSession = useChatStore((state) => state.selectSession)
  const cancelExecution = useAgentStore((state) => state.cancelExecution)
  const session = sessions.find((candidate) => candidate.id === currentSessionId)
  const projection = useSubagentProjectionStore((state) =>
    currentSessionId ? state.byChildSessionId[currentSessionId] : undefined
  )
  if (!session || session.kind !== 'subagent') return null

  const active = projection && ![
    'completed',
    'failed',
    'cancelled',
    'interrupted',
    'record_missing'
  ].includes(projection.status)

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
    </header>
  )
}
