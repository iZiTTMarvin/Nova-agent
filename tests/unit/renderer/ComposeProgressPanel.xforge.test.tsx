import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposeProgressPanel } from '../../../src/renderer/features/compose/ComposeProgressPanel'
import { resetAgentStoreForTests } from '../../../src/renderer/stores/useAgentStore'
import { useRunStore } from '../../../src/renderer/stores/useRunStore'
import type { RunSnapshot } from '../../../src/shared/run/types'
import { createInitialXForgeRunState } from '../../../src/runtime/workflow/xforge/runState'

const mockInvoke = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  resetAgentStoreForTests()
  useRunStore.getState().resetForTests()
  global.window = {
    ...global.window,
    api: {
      invoke: mockInvoke,
      on: vi.fn(() => () => {}),
      removeAllListeners: vi.fn()
    }
  } as unknown as Window & typeof globalThis
})

function makeSnapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  const now = 1_789_000_000_000
  return {
    runId: 'run-xforge',
    kind: 'xforge',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    messageId: 'message-1',
    status: 'running',
    sequence: 1,
    pendingInteractions: [],
    currentAttempt: null,
    progress: null,
    lastHeartbeatAt: now,
    createdAt: now,
    updatedAt: now,
    xforge: createInitialXForgeRunState(),
    ...overrides
  }
}

function renderPanel(snapshot: RunSnapshot): TestRenderer.ReactTestRenderer {
  useRunStore.setState({ snapshot })
  let renderer: TestRenderer.ReactTestRenderer | null = null
  act(() => {
    renderer = TestRenderer.create(React.createElement(ComposeProgressPanel))
  })
  return renderer!
}

function openPanel(renderer: TestRenderer.ReactTestRenderer): void {
  const header = renderer.root.find(
    node => node.type === 'button' && node.props.className === 'compose-panel__header'
  )
  act(() => {
    header.props.onClick()
  })
}

function expectText(root: TestRenderer.ReactTestInstance, text: string): void {
  expect(flattenText(root)).toContain(text)
}

function flattenText(node: TestRenderer.ReactTestInstance): string {
  return node.children.map(child => {
    if (typeof child === 'string' || typeof child === 'number') return String(child)
    return flattenText(child)
  }).join('')
}

describe('ComposeProgressPanel XForge view', () => {
  it('展示固定阶段 stepper 与 completed/skipped/current 状态', () => {
    const snapshot = makeSnapshot({
      status: 'completed',
      xforge: {
        ...createInitialXForgeRunState(),
        currentStage: 'completed',
        completedStages: ['resolve', 'plan', 'test', 'review', 'report'],
        skippedStages: ['brainstorm'],
        testEvidence: {
          workspaceRevision: 3,
          fingerprint: { revision: 3, digest: 'abc', capturedAt: 1 },
          passed: true,
          capturedAt: 2,
          commands: []
        },
        tasks: [
          {
            id: 'T1',
            title: '完成核心实现',
            status: 'done',
            acceptance: ['通过测试'],
            attempts: 1,
            evidenceRefs: []
          },
          {
            id: 'T2',
            title: '补充边界验证',
            status: 'unverified',
            acceptance: ['需要人工验证'],
            attempts: 0,
            evidenceRefs: []
          },
          {
            id: 'T3',
            title: '保留发布动作',
            status: 'skipped',
            acceptance: [],
            attempts: 0,
            evidenceRefs: [],
            failureReason: 'not_executed'
          }
        ],
        evidenceRefs: [{ kind: 'manual-smoke', unverified: true }],
        reviewFindings: [
          {
            severity: 'high',
            location: 'src/example.ts',
            summary: '需要复查',
            evidence: 'review note',
            unverified: true
          }
        ],
        technicalDebt: [
          {
            severity: 'low',
            location: 'tests',
            summary: '后续补端到端截图',
            evidence: 'manual',
            unverified: true
          }
        ]
      }
    })

    const renderer = renderPanel(snapshot)
    openPanel(renderer)
    const root = renderer.root

    expect(root.findAll(node => node.props.className === 'compose-panel__step')).toHaveLength(7)
    expect(root.findAll(node => node.props['data-status'] === 'skipped').length).toBeGreaterThan(0)
    expectText(root, 'Test Gate：通过')
    expectText(root, 'Blocking：1')
    expectText(root, '未验证证据 4')
    expectText(root, '完成核心实现')
    expectText(root, '补充边界验证')
    expectText(root, '保留发布动作')
  })

  it('waiting_user 展示 resume target 与安全阻塞信息', () => {
    const snapshot = makeSnapshot({
      status: 'waiting_user',
      xforge: {
        ...createInitialXForgeRunState(),
        currentStage: 'waiting_user',
        completedStages: ['resolve', 'plan'],
        suspendedStage: 'test',
        resumeTarget: 'test',
        waitingReason: 'Workspace fingerprint drift，测试证据已失效'
      }
    })

    const renderer = renderPanel(snapshot)
    openPanel(renderer)
    const root = renderer.root

    expectText(root, '安全阻塞')
    expectText(root, 'Workspace fingerprint drift')
    expectText(root, '从 Test Gate 继续')
    expect(root.findAll(node => node.props['data-kind'] === 'drift')).toHaveLength(1)
  })
})
