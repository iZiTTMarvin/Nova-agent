import React, { useMemo } from 'react'
import type {
  SubagentActivityProjection,
  SubagentBatchProjection,
  SubagentBatchStatus
} from '../../../shared/subagents'
import type { ToolTraceRowProps } from '../chat/ToolTraceRow'
import { ToolTraceRow } from '../chat/ToolTraceRow'
import { useChatStore } from '../../stores/useChatStore'
import { SubagentActivityRow } from './SubagentActivityRow'
import { SubagentBatchRow } from './SubagentBatchRow'
import { useSubagentProjectionStore } from './projection'

function aggregateStatus(
  members: readonly SubagentActivityProjection[]
): SubagentBatchStatus {
  const statuses = members.map((member) => member.status)
  if (statuses.some((status) =>
    status === 'queued' ||
    status === 'running' ||
    status === 'waiting_user' ||
    status === 'retrying' ||
    status === 'resuming' ||
    status === 'cancelling'
  )) return 'running'
  if (statuses.every((status) => status === 'completed')) return 'completed'
  if (statuses.every((status) => status === 'cancelled')) return 'cancelled'
  if (statuses.some((status) => status === 'completed')) return 'partial'
  return 'failed'
}

function toBatch(
  batchId: string,
  members: readonly SubagentActivityProjection[]
): SubagentBatchProjection {
  return {
    batchId,
    parentSessionId: members[0]!.parentSessionId,
    status: aggregateStatus(members),
    members: members.map((member) => ({
      childSessionId: member.childSessionId,
      childRunId: member.childRunId,
      profileName: member.profile.name,
      status: member.status
    }))
  }
}

export interface WorkflowSubagentRowsProps extends ToolTraceRowProps {
  toolCallId: string
}

/** start_workflow 工具行只承载容器；成员状态全部由 durable child projections 聚合。 */
export const WorkflowSubagentRows: React.FC<WorkflowSubagentRowsProps> = (props) => {
  const parentSessionId = useChatStore((state) => state.currentSessionId)
  const byChildSessionId = useSubagentProjectionStore((state) => state.byChildSessionId)
  const candidates = useMemo(
    () => Object.values(byChildSessionId).filter(
      (projection) =>
        projection.workflow !== undefined &&
        projection.parentSessionId === parentSessionId &&
        projection.parentToolCallId === props.toolCallId
    ),
    [byChildSessionId, parentSessionId, props.toolCallId]
  )
  const projections = useMemo(() => {
    const workflowRunIds = new Set(
      candidates.flatMap((projection) =>
        projection.workflow ? [projection.workflow.workflowRunId] : []
      )
    )
    if (workflowRunIds.size !== 1) return []
    const [workflowRunId] = workflowRunIds
    return candidates.filter(
      (projection) => projection.workflow?.workflowRunId === workflowRunId
    )
  }, [candidates])
  const groups = useMemo(() => {
    const batches = new Map<string, SubagentActivityProjection[]>()
    const singles: SubagentActivityProjection[] = []
    for (const projection of projections) {
      const batchId = projection.workflow?.batchId
      if (!batchId) {
        singles.push(projection)
        continue
      }
      const members = batches.get(batchId) ?? []
      members.push(projection)
      batches.set(batchId, members)
    }
    return { batches, singles }
  }, [projections])

  if (projections.length === 0) return <ToolTraceRow {...props} />
  return (
    <div className="workflow-subagent-rows">
      {groups.singles.map((projection) => (
        <SubagentActivityRow key={projection.childSessionId} projection={projection} />
      ))}
      {[...groups.batches].map(([batchId, members]) =>
        members.length > 1
          ? <SubagentBatchRow key={batchId} projection={toBatch(batchId, members)} />
          : <SubagentActivityRow key={members[0]!.childSessionId} projection={members[0]!} />
      )}
    </div>
  )
}
