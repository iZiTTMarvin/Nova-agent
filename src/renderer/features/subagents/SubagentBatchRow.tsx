import React from 'react'
import { ClickableCard } from '@astryxdesign/core/ClickableCard'
import type { SubagentBatchProjection } from '../../../shared/subagents'
import { useChatStore } from '../../stores/useChatStore'
import './SubagentActivityRow.css'

const MEMBER_STATUS: Record<string, { icon: string; label: string }> = {
  queued: { icon: '○', label: '等待开始' },
  running: { icon: '●', label: '运行中' },
  waiting_user: { icon: '!', label: '等待授权' },
  retrying: { icon: '●', label: '重试中' },
  resuming: { icon: '●', label: '恢复中' },
  cancelling: { icon: '◌', label: '停止中' },
  completed: { icon: '✓', label: '已完成' },
  failed: { icon: '×', label: '失败' },
  cancelled: { icon: '■', label: '已取消' },
  interrupted: { icon: '◇', label: '已中断' },
  record_missing: { icon: '?', label: '记录不可用' }
}

export const SubagentBatchRow: React.FC<{ projection: SubagentBatchProjection }> = ({
  projection
}) => {
  const selectSession = useChatStore((state) => state.selectSession)
  return (
    <section className="subagent-batch-row" aria-label={`并行执行，${projection.members.length} 个子代理`}>
      <div className="subagent-batch-row__header">
        <span aria-hidden="true">⇉</span>
        <span>并行执行 · {projection.members.length} 个子代理</span>
        <span>{projection.status}</span>
      </div>
      {projection.members.map((member) => {
        const status = MEMBER_STATUS[member.status]
        return (
          <ClickableCard
            label={`打开 ${member.profileName}，${status.label}`}
            variant="transparent"
            padding={0}
            width="100%"
            key={member.childSessionId}
            className="subagent-batch-row__member"
            onClick={() => void selectSession(member.childSessionId)}
          >
            <span aria-hidden="true">{status.icon}</span>
            <span>{member.profileName}</span>
            <span>{status.label}</span>
          </ClickableCard>
        )
      })}
    </section>
  )
}
