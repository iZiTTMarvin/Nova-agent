/**
 * 编排进度块的渲染链路：store 追加 → 渲染单元 → 文案；以及运行态 store 的会话门控。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useChatStore, resetChatStoreForTests } from '../../../src/renderer/stores/useChatStore'
import { useWorkflowStore } from '../../../src/renderer/features/workflow/useWorkflowStore'
import { buildBlockRenderUnits } from '../../../src/renderer/features/chat/toolCallGrouping'
import { formatProgressText } from '../../../src/renderer/features/chat/WorkflowProgressBlock'
import { buildTurnRenderModel } from '../../../src/renderer/features/chat/turnProcessModel'
import type { ExtendedMessage, RendererMessageBlock } from '../../../src/renderer/stores/types'

function assistantMessage(id: string, blocks: RendererMessageBlock[] = []): ExtendedMessage {
  return {
    id,
    sessionId: 'sess_1',
    role: 'assistant',
    content: '',
    blocks,
    timestamp: 0,
    _revision: 0
  }
}

describe('handleWorkflowProgress', () => {
  beforeEach(() => {
    resetChatStoreForTests()
  })

  it('把进度块追加到当前生成中消息，并 bump revision', () => {
    useChatStore.setState({
      currentSessionId: 'sess_1',
      messages: [assistantMessage('msg_1')],
      messageIndexById: { msg_1: 0 },
      currentGeneratingMessageId: 'msg_1'
    })

    useChatStore.getState().handleWorkflowProgress({
      runId: 'run-1',
      phase: 'implement',
      status: 'task_complete',
      detail: { taskId: 't-1', taskName: '加缓存' }
    })

    const msg = useChatStore.getState().messages[0]
    expect(msg.blocks).toEqual([
      {
        type: 'workflow_progress',
        runId: 'run-1',
        phase: 'implement',
        status: 'task_complete',
        detail: { taskId: 't-1', taskName: '加缓存' }
      }
    ])
    expect(msg._revision).toBe(1)
  })

  it('无生成中消息时丢弃，不写进历史消息', () => {
    useChatStore.setState({
      currentSessionId: 'sess_1',
      messages: [assistantMessage('msg_1')],
      messageIndexById: { msg_1: 0 },
      currentGeneratingMessageId: null
    })

    useChatStore.getState().handleWorkflowProgress({
      runId: 'run-1',
      phase: 'implement',
      status: 'started'
    })

    expect(useChatStore.getState().messages[0].blocks).toEqual([])
  })

  it('多条进度事件按到达顺序累积', () => {
    useChatStore.setState({
      currentSessionId: 'sess_1',
      messages: [assistantMessage('msg_1')],
      messageIndexById: { msg_1: 0 },
      currentGeneratingMessageId: 'msg_1'
    })

    const store = useChatStore.getState()
    store.handleWorkflowProgress({ runId: 'r', phase: 'brainstorm', status: 'started' })
    store.handleWorkflowProgress({ runId: 'r', phase: 'brainstorm', status: 'completed' })
    store.handleWorkflowProgress({ runId: 'r', phase: 'plan', status: 'started' })

    const blocks = useChatStore.getState().messages[0].blocks ?? []
    expect(blocks.map((b) => (b.type === 'workflow_progress' ? `${b.phase}:${b.status}` : b.type)))
      .toEqual(['brainstorm:started', 'brainstorm:completed', 'plan:started'])
  })
})

describe('进度块进入渲染单元', () => {
  it('buildBlockRenderUnits 输出 block 单元并打断 tool 聚合', () => {
    const units = buildBlockRenderUnits(
      [
        { type: 'tool', toolCallId: 'c1', toolName: 'read', arguments: {}, status: 'success' },
        { type: 'workflow_progress', runId: 'r', phase: 'implement', status: 'started' },
        { type: 'tool', toolCallId: 'c2', toolName: 'read', arguments: {}, status: 'success' }
      ],
      'compose'
    )

    expect(units.map((u) => u.kind)).toEqual(['tool', 'block', 'tool'])
    const blockUnit = units[1]
    expect(blockUnit.kind === 'block' && blockUnit.block.type).toBe('workflow_progress')
  })

  it('工具之后的进度块落在结论区（answerUnits），不被过程树吞掉', () => {
    const model = buildTurnRenderModel({
      blocks: [
        {
          type: 'tool',
          toolCallId: 'c1',
          toolName: 'bash',
          arguments: {},
          status: 'success'
        },
        { type: 'workflow_progress', runId: 'r', phase: 'implement', status: 'started' }
      ],
      toolCalls: undefined,
      mode: 'compose',
      phase: 'live'
    })

    expect(model.hasProcess).toBe(true)
    expect(model.answerUnits).toHaveLength(1)
    const unit = model.answerUnits[0]
    expect(unit.kind === 'block' && unit.block.type).toBe('workflow_progress')
  })

  it('工具之前的进度块进入过程时间线', () => {
    const model = buildTurnRenderModel({
      blocks: [
        { type: 'workflow_progress', runId: 'r', phase: 'plan', status: 'started' },
        { type: 'tool', toolCallId: 'c1', toolName: 'bash', arguments: {}, status: 'success' }
      ],
      toolCalls: undefined,
      mode: 'compose',
      phase: 'live'
    })

    const kinds = model.processTimeline.map((s) =>
      s.kind === 'block' ? s.block.type : s.kind
    )
    expect(kinds).toEqual(['workflow_progress', 'tool'])
  })
})

describe('formatProgressText', () => {
  it('阶段名翻译为中文标签', () => {
    expect(
      formatProgressText({ type: 'workflow_progress', runId: 'r', phase: 'implement', status: 'started' })
    ).toBe('进入 编码实现')
  })

  it('未收录阶段直接显示原名', () => {
    expect(
      formatProgressText({ type: 'workflow_progress', runId: 'r', phase: 'custom', status: 'started' })
    ).toBe('进入 custom')
  })

  it('detail 拼接任务名与批次信息', () => {
    expect(
      formatProgressText({
        type: 'workflow_progress',
        runId: 'r',
        phase: 'implement',
        status: 'batch_started',
        detail: { batchIndex: 2, batchSize: 3 }
      })
    ).toBe('并行批次 编码实现 — 第 2 批 / 3 个任务')

    expect(
      formatProgressText({
        type: 'workflow_progress',
        runId: 'r',
        phase: 'implement',
        status: 'task_failed',
        detail: { taskName: '接缓存', message: 'typecheck 未过' }
      })
    ).toBe('任务失败 编码实现 — 接缓存，typecheck 未过')
  })
})

describe('useWorkflowStore 运行态门控', () => {
  beforeEach(() => {
    useWorkflowStore.getState().clear()
  })

  it('running 事件写入 activeRun，终态清空', () => {
    const store = useWorkflowStore.getState()
    store.applyRunState({
      runId: 'run-1',
      sessionId: 'sess_1',
      workflow: 'compose',
      status: 'running',
      phase: 'brainstorm'
    })
    expect(useWorkflowStore.getState().isRunningForSession('sess_1')).toBe(true)
    expect(useWorkflowStore.getState().isRunningForSession('sess_2')).toBe(false)

    useWorkflowStore.getState().applyRunState({
      runId: 'run-1',
      sessionId: 'sess_1',
      workflow: 'compose',
      status: 'completed',
      phase: 'report'
    })
    expect(useWorkflowStore.getState().activeRun).toBeNull()
  })

  it('其它 runId 的终态不清掉当前 activeRun', () => {
    const store = useWorkflowStore.getState()
    store.applyRunState({
      runId: 'run-1',
      sessionId: 'sess_1',
      workflow: 'compose',
      status: 'running',
      phase: 'plan'
    })
    useWorkflowStore.getState().applyRunState({
      runId: 'run-other',
      sessionId: 'sess_2',
      workflow: 'compose',
      status: 'cancelled',
      phase: 'plan'
    })
    expect(useWorkflowStore.getState().activeRun?.runId).toBe('run-1')
  })

  it('终态同时清掉 busy 提示', () => {
    const store = useWorkflowStore.getState()
    store.applyRunState({
      runId: 'run-1',
      sessionId: 'sess_1',
      workflow: 'compose',
      status: 'running',
      phase: 'plan'
    })
    useWorkflowStore.getState().showBusyNotice({ runId: 'run-1', workflow: 'compose', phase: 'plan' })
    useWorkflowStore.getState().applyRunState({
      runId: 'run-1',
      sessionId: 'sess_1',
      workflow: 'compose',
      status: 'failed',
      phase: 'plan'
    })
    expect(useWorkflowStore.getState().busyNotice).toBeNull()
  })
})
