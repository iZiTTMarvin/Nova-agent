// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  SubagentActivityRow,
  SubagentToolRow
} from '../../../src/renderer/features/subagents/SubagentActivityRow'
import { useSubagentProjectionStore } from '../../../src/renderer/features/subagents/projection'
import type { SubagentActivityProjection } from '../../../src/shared/subagents'
import { renderDom } from './renderDom'

const projection: SubagentActivityProjection = {
  childSessionId: 'sess-child',
  childRunId: 'internal-run-id',
  parentSessionId: 'sess-parent',
  parentToolCallId: 'call-task',
  taskLabel: '检查运行时边界',
  profile: {
    profileId: 'explore',
    name: 'Explore',
    permissionCeiling: 'read_only'
  },
  status: 'completed',
  startedAt: 1_000,
  completedAt: 3_000,
  summary: '检查完成',
  artifactCount: 2
}

describe('SubagentActivityRow', () => {
  beforeEach(() => useSubagentProjectionStore.getState().resetForTests())

  it('显示可理解状态、摘要与产物，默认不暴露内部 ID', () => {
    const renderer = renderDom(<SubagentActivityRow projection={projection} />)
    const output = renderer.container.textContent ?? ''
    expect(output).toContain('检查运行时边界')
    expect(output).toContain('已完成')
    expect(output).toContain('检查完成')
    expect(renderer.container.querySelector('.subagent-activity-row__artifacts')?.textContent)
      .toBe('2 个产物')
    expect(output).not.toContain('internal-run-id')
    renderer.unmount()
  })

  it('没有结构化 lineage 时保留旧 task ToolTraceRow', () => {
    const renderer = renderDom(
      <SubagentToolRow
        toolCallId="legacy-call"
        name="task"
        status="success"
        result="[子代理 explore / old]\nlegacy summary"
      />
    )
    expect(renderer.container.querySelector('.tool-trace-row')).not.toBeNull()
    renderer.unmount()
  })
})
