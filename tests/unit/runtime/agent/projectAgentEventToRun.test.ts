/**
 * AgentEvent → Run 进度投影：子代理活动行的实时标签随事件推进。
 * 回归保护：子代理运行期间长时间无任何进度反馈（首响应延迟被误读为卡死）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { RunStore } from '../../../../src/runtime/run/RunStore'
import { RunCoordinator } from '../../../../src/runtime/run/RunCoordinator'
import { projectAgentEventToRun } from '../../../../src/runtime/agent/turn'

describe('projectAgentEventToRun 进度标签', () => {
  let tmpDir: string
  let coord: RunCoordinator
  let runId: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-run-projection-'))
    coord = new RunCoordinator({ store: new RunStore({ runsRoot: tmpDir }) })
    runId = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's1' }).runId
  })

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  function project(event: Parameters<typeof projectAgentEventToRun>[1]): void {
    projectAgentEventToRun(
      { runCoordinator: coord, runId, resourceOwnerRunId: runId, sessionId: 's1' },
      event
    )
  }

  it('消息开始 → 思考中；工具调用 → 调用工具名；轮次完成 → 完成回复', () => {
    project({ type: 'message_start', messageId: 'm1' })
    expect(coord.getSnapshot(runId)?.progress?.label).toBe('正在思考…')

    project({
      type: 'tool_call',
      messageId: 'm1',
      toolCallId: 'c1',
      toolName: 'read',
      args: {}
    })
    expect(coord.getSnapshot(runId)?.progress?.label).toBe('调用 read')

    project({ type: 'message_end', messageId: 'm1' })
    expect(coord.getSnapshot(runId)?.progress?.label).toBe('完成一轮回复')
  })

  it('中断轮次的标签保持可辨识', () => {
    project({ type: 'message_start', messageId: 'm2' })
    project({ type: 'message_end', messageId: 'm2', interrupted: true })
    expect(coord.getSnapshot(runId)?.progress?.label).toBe('interrupted')
  })

  it('嵌套工具事件（run_code 沙箱内调用）不改变进度标签', () => {
    project({ type: 'message_start', messageId: 'm3' })
    project({
      type: 'tool_call',
      messageId: 'm3',
      toolCallId: 'tc_run_code#nested-1',
      toolName: 'read',
      args: {},
      parentToolCallId: 'tc_run_code'
    })
    expect(coord.getSnapshot(runId)?.progress?.label).toBe('正在思考…')
  })
})
