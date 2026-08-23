// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SubagentActivityRow,
  SubagentToolRow
} from '../../../src/renderer/features/subagents/SubagentActivityRow'
import { useSubagentProjectionStore } from '../../../src/renderer/features/subagents/projection'
import {
  resetAgentStoreForTests,
  useAgentStore
} from '../../../src/renderer/stores/useAgentStore'
import type { SubagentActivityProjection } from '../../../src/shared/subagents'
import { renderDom, act } from './renderDom'

const mockInvoke = vi.fn()
const mockOn = vi.fn(() => () => {})

function baseProjection(
  overrides: Partial<SubagentActivityProjection> = {}
): SubagentActivityProjection {
  return {
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
    artifactCount: 2,
    ...overrides
  }
}

function flushAsync(): Promise<void> {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('SubagentActivityRow', () => {
  beforeEach(() => {
    useSubagentProjectionStore.getState().resetForTests()
    resetAgentStoreForTests()
    mockInvoke.mockReset()
    mockOn.mockReset()
    // 就地替换 bridge（不重建 window，避免丢失 jsdom 原型上的 matchMedia）
    // @ts-expect-error jsdom 测试环境手动挂载 bridge，global.window 类型未声明 api
    global.window.api = {
      invoke: mockInvoke,
      on: mockOn,
      removeAllListeners: vi.fn()
    } as never
    mockInvoke.mockImplementation((channel: string, params: unknown) => {
      if (channel === 'load-session-messages') {
        return Promise.resolve({ messages: [], hasMore: false })
      }
      if (channel === 'get-session-diffs') {
        return Promise.resolve({ diffs: [], reviews: {}, messageIdByFile: {}, skippedFiles: [] })
      }
      return Promise.resolve(undefined)
    })
  })

  it('运行态：显示当前动作与呼吸微光 class，状态与耗时可见', () => {
    const renderer = renderDom(
      <SubagentActivityRow
        projection={baseProjection({
          status: 'running',
          startedAt: 1_000,
          summary: undefined,
          latestActivity: 'Reading src/…'
        })}
      />
    )
    const output = renderer.container.textContent ?? ''
    expect(renderer.container.querySelector('.subagent-activity-row--running')).not.toBeNull()
    expect(renderer.container.querySelector('.subagent-activity-row__activity--live'))
      .not.toBeNull()
    expect(output).toContain('Reading src/')
    expect(output).toContain('正在工作')
    renderer.unmount()
  })

  it('完成态：次行翻转为摘要一句话，无微光 class', () => {
    const renderer = renderDom(
      <SubagentActivityRow projection={baseProjection({ status: 'completed' })} />
    )
    const output = renderer.container.textContent ?? ''
    expect(output).toContain('检查完成')
    expect(output).toContain('已完成')
    expect(renderer.container.querySelector('.subagent-activity-row__activity--live')).toBeNull()
    renderer.unmount()
  })

  it('失败态：次行展示 failure.message', () => {
    const renderer = renderDom(
      <SubagentActivityRow
        projection={baseProjection({
          status: 'failed',
          failure: { code: 'tool', message: '读取被拒绝' }
        })}
      />
    )
    expect(renderer.container.textContent ?? '').toContain('读取被拒绝')
    renderer.unmount()
  })

  it('模型与思考强度显示：auto/缺省省略对应段', () => {
    const withEffort = renderDom(
      <SubagentActivityRow
        projection={baseProjection({
          model: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
          reasoningEffort: 'high'
        })}
      />
    )
    expect(withEffort.container.textContent ?? '').toContain('deepseek-v4-flash · high')
    withEffort.unmount()

    const autoEffort = renderDom(
      <SubagentActivityRow
        projection={baseProjection({
          model: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
          reasoningEffort: 'auto'
        })}
      />
    )
    const autoText = autoEffort.container.textContent ?? ''
    expect(autoText).toContain('deepseek-v4-flash')
    expect(autoText).not.toContain('auto')
    autoEffort.unmount()

    const noModel = renderDom(<SubagentActivityRow projection={baseProjection()} />)
    expect(noModel.container.querySelector('.subagent-activity-row__model')).toBeNull()
    noModel.unmount()
  })

  it('点击行展开悬浮面板并渲染子会话消息，不触发会话跳转', async () => {
    const messages = [
      {
        id: 'msg-1',
        sessionId: 'sess-child',
        role: 'user' as const,
        content: '请检查',
        timestamp: 1
      },
      {
        id: 'msg-2',
        sessionId: 'sess-child',
        role: 'assistant' as const,
        content: 'final report text',
        timestamp: 2,
        blocks: [
          {
            type: 'tool' as const,
            toolCallId: 'call-1',
            toolName: 'read',
            arguments: { path: 'src/a.ts' },
            status: 'success' as const,
            result: 'ok'
          },
          { type: 'thinking' as const, content: '先看目录结构' },
          { type: 'text' as const, content: 'final report text' }
        ]
      }
    ]
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'load-session-messages') {
        return Promise.resolve({ messages, hasMore: false })
      }
      return Promise.resolve(undefined)
    })

    const renderer = renderDom(
      <SubagentActivityRow
        projection={baseProjection({ status: 'running', latestActivity: 'Reading src/…' })}
      />
    )
    const trigger = renderer.container.querySelector<HTMLButtonElement>(
      '.subagent-activity-row__trigger'
    )
    expect(trigger).not.toBeNull()
    act(() => trigger!.click())
    await flushAsync()

    // 面板 portal 到 body，脱离消息流滚动容器与虚拟行 transform，fixed 定位防裁剪
    const popover = document.body.querySelector<HTMLElement>('.subagent-detail-popover')
    expect(popover).not.toBeNull()
    expect(popover?.style.position).toBe('fixed')
    const popoverText = document.body.textContent ?? ''
    expect(popoverText).toContain('final report text')
    expect(popoverText).toContain('read')
    expect(popoverText).toContain('先看目录结构')
    expect(popoverText).toContain('2 个产物')
    // 面板只读拉取，不触发任何会话切换 IPC
    const invokedChannels = mockInvoke.mock.calls.map((call) => call[0])
    expect(invokedChannels).not.toContain('workspace:select-session')
    expect(invokedChannels).not.toContain('load-session')

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.body.querySelector('.subagent-detail-popover')).toBeNull()
    renderer.unmount()
  })

  it('终态且有文件改动时展示 diff 卡：统计、Show N more 折叠展开', () => {
    const fileChanges = Array.from({ length: 6 }, (_, index) => ({
      filePath: `src/file-${index}.ts`,
      status: (index % 2 === 0 ? 'modified' : 'added') as 'modified' | 'added',
      addedLines: index + 1,
      removedLines: index % 2 === 0 ? 1 : 0
    }))
    const renderer = renderDom(
      <SubagentActivityRow
        projection={baseProjection({ status: 'completed', fileChanges })}
      />
    )
    const output = renderer.container.textContent ?? ''
    expect(renderer.container.querySelector('.subagent-diff-card')).not.toBeNull()
    expect(output).toContain('6 个文件改动')
    expect(renderer.container.querySelectorAll('.subagent-diff-card__file')).toHaveLength(5)
    expect(output).toContain('Show 1 more')

    act(() => {
      const more = renderer.container.querySelector<HTMLButtonElement>(
        '.subagent-diff-card__more'
      )
      more!.click()
    })
    expect(renderer.container.querySelectorAll('.subagent-diff-card__file')).toHaveLength(6)
    expect(renderer.container.textContent ?? '').toContain('+6')
    renderer.unmount()
  })

  it('只读子代理（无 fileChanges）不出现 diff 卡', () => {
    const renderer = renderDom(<SubagentActivityRow projection={baseProjection()} />)
    expect(renderer.container.querySelector('.subagent-diff-card')).toBeNull()
    renderer.unmount()
  })

  it('Review 展开 DiffViewer，accept 按 messageIdByFile 路由到既有消息级 IPC', async () => {
    const projectState = {
      diffs: [
        {
          filePath: 'src/a.ts',
          status: 'modified' as const,
          hunks: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              content: '-old\n+new'
            }
          ]
        }
      ],
      reviews: {},
      messageIdByFile: { 'src/a.ts': 'msg-early' },
      skippedFiles: []
    }
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'get-session-diffs') return Promise.resolve(projectState)
      if (channel === 'accept-file' || channel === 'reject-file') return Promise.resolve()
      return Promise.resolve(undefined)
    })

    const renderer = renderDom(
      <SubagentActivityRow
        projection={baseProjection({
          status: 'completed',
          fileChanges: [
            { filePath: 'src/a.ts', status: 'modified', addedLines: 1, removedLines: 1 }
          ]
        })}
      />
    )
    act(() => {
      const review = renderer.container.querySelector<HTMLButtonElement>(
        '.subagent-diff-card__review-btn'
      )
      review!.click()
    })
    await flushAsync()

    expect(renderer.container.querySelector('.diff-viewer')).not.toBeNull()
    // 会话级聚合视图逐文件路由消息各异，文件头仍可按自身 hunk 折叠，但不提供审查按钮
    const fileHeader = renderer.container.querySelector('.diff-file__header')
    expect(fileHeader?.getAttribute('role')).toBe('button')
    const reviewBtn = Array.from(renderer.container.querySelectorAll('button'))
      .find(b => b.textContent === '审查')
    expect(reviewBtn).toBeUndefined()
    const accept = renderer.container.querySelector<HTMLButtonElement>('.diff-action-btn--accept')
    expect(accept).not.toBeNull()
    act(() => accept!.click())
    await flushAsync()

    expect(mockInvoke).toHaveBeenCalledWith('accept-file', {
      sessionId: 'sess-child',
      messageId: 'msg-early',
      filePath: 'src/a.ts'
    })
    renderer.unmount()
  })

  it('子代理权限请求锚定到父会话视图的对应活动行，可拒绝并送达子 run', async () => {
    useAgentStore.getState().handlePermissionRequest({
      messageId: 'msg-child',
      requestId: 'perm-child',
      toolName: 'bash',
      args: { command: 'npm test' },
      riskLevel: 'medium',
      reason: '运行测试命令',
      sessionId: 'sess-child',
      interactionId: 'perm-child',
      version: 1
    })

    const renderer = renderDom(
      <SubagentActivityRow projection={baseProjection({ status: 'waiting_user' })} />
    )
    const bar = renderer.container.querySelector('.subagent-activity-row__permission')
    expect(bar).not.toBeNull()
    expect(
      renderer.container.querySelector('.subagent-activity-row__permission-label')?.textContent
    ).toContain('子代理')
    expect(bar?.textContent ?? '').toContain('运行测试命令')

    const deny = renderer.container.querySelector<HTMLButtonElement>(
      '.inline-perm__btn--deny'
    )
    expect(deny).not.toBeNull()
    act(() => deny!.click())
    await flushAsync()

    expect(mockInvoke).toHaveBeenCalledWith(
      'respond-permission',
      expect.objectContaining({
        requestId: 'perm-child',
        decision: 'deny',
        interactionId: 'perm-child',
        expectedVersion: 1
      })
    )
    expect(useAgentStore.getState().pendingPermissionRequest).toBeNull()
    renderer.unmount()
  })

  it('其他会话的权限请求不锚定到本行', () => {
    useAgentStore.getState().handlePermissionRequest({
      messageId: 'msg-x',
      requestId: 'perm-x',
      toolName: 'bash',
      args: {},
      riskLevel: 'low',
      reason: '',
      sessionId: 'sess-other'
    })
    const renderer = renderDom(
      <SubagentActivityRow projection={baseProjection({ status: 'waiting_user' })} />
    )
    expect(renderer.container.querySelector('.subagent-activity-row__permission')).toBeNull()
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
