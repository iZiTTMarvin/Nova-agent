/**
 * deep-research workflow 的定向测试。
 *
 * 保护的不变量：
 * - research 阶段是真并发，不是串行 for-await；
 * - 单个子问题失败不连坐其余子问题，也不让整阶段失败；
 * - 全部子问题失败时不继续 synthesize；
 * - 只读阶段永远不携带写入、执行或提问工具；
 * - 无来源引用的结论被强制 block；
 * - 阶段间取消能立刻终止编排。
 */
import { describe, expect, it } from 'vitest'
import { READONLY_TOOLS } from '../../../../../src/runtime/workflow/host'
import type { AgentOptions, AgentResult, HostFns, WorktreeHandle } from '../../../../../src/runtime/workflow/host'
import type { WorkflowRunContext } from '../../../../../src/runtime/workflow/definitions/types'
import {
  deepResearchWorkflow,
  normalizeFinding,
  normalizeResearchReview,
  runResearch
} from '../../../../../src/runtime/workflow/definitions/deep-research'
import type {
  ResearchBrief,
  ResearchFindings,
  ResearchSynthesis
} from '../../../../../src/runtime/workflow/definitions/deep-research'

interface AgentCall {
  prompt: string
  options?: AgentOptions
}

interface ProgressEvent {
  phase: string
  status: string
  taskId?: string
  message?: string
}

interface Harness {
  host: HostFns
  calls: AgentCall[]
  progress: ProgressEvent[]
  /** research 阶段同时在飞的子 agent 峰值，用于证明并发而非串行 */
  peakConcurrency: number
}

const BRIEF_OUTPUT = {
  question: 'Electron 主进程如何安全暴露 IPC',
  subQuestions: [
    { id: 'sub-1', question: 'contextBridge 的安全边界是什么', rationale: '决定 preload 写法' },
    { id: 'sub-2', question: 'nodeIntegration 关闭后如何访问 fs' }
  ],
  successCriteria: ['两个子问题都有官方文档来源'],
  outOfScope: ['打包签名']
}

const FINDING_OUTPUT = {
  status: 'answered',
  answer: 'contextBridge 只暴露显式白名单方法',
  evidence: [{ source: 'https://www.electronjs.org/docs/latest/api/context-bridge', confidence: 'high' }],
  gaps: []
}

const SYNTHESIS_OUTPUT = {
  conclusion: '通过 contextBridge 暴露类型化白名单方法即可',
  keyPoints: ['preload 只暴露方法，不暴露模块'],
  conflicts: [],
  unresolved: [],
  recommendations: ['为每个通道加输入校验'],
  citations: ['https://www.electronjs.org/docs/latest/api/context-bridge']
}

const REVIEW_OUTPUT = {
  verdict: 'pass',
  summary: '结论有官方文档支撑',
  issues: [],
  unsupportedClaims: []
}

function makeHarness(
  behavior?: (prompt: string, options: AgentOptions | undefined) => Promise<AgentResult>
): Harness {
  const calls: AgentCall[] = []
  const progress: ProgressEvent[] = []
  let inFlight = 0
  const harness: Harness = {
    calls,
    progress,
    peakConcurrency: 0,
    host: undefined as unknown as HostFns
  }

  const defaultBehavior = async (
    _prompt: string,
    options: AgentOptions | undefined
  ): Promise<AgentResult> => {
    if (options?.phase === 'brief') return BRIEF_OUTPUT
    if (options?.phase === 'research') return FINDING_OUTPUT
    if (options?.phase === 'synthesize') return SYNTHESIS_OUTPUT
    if (options?.phase === 'review') return REVIEW_OUTPUT
    return null
  }
  const agentBehavior = behavior ?? defaultBehavior

  harness.host = {
    agent: async (prompt, options) => {
      calls.push({ prompt, ...(options ? { options } : {}) })
      if (options?.phase === 'research') {
        inFlight += 1
        harness.peakConcurrency = Math.max(harness.peakConcurrency, inFlight)
      }
      try {
        return await agentBehavior(prompt, options)
      } finally {
        if (options?.phase === 'research') inFlight -= 1
      }
    },
    bash: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    read: async () => null,
    write: async () => undefined,
    delete: async () => undefined,
    exists: async () => false,
    glob: async () => [],
    worktree: async (key): Promise<WorktreeHandle> => ({
      key,
      name: key,
      branch: `${key}-branch`,
      directory: `/tmp/${key}`,
      baseSha: 'base',
      reused: false
    }),
    integrate: async () => ({ status: 'pristine' }),
    cleanupWorktree: async () => true,
    progress: (phase, status, detail) => {
      progress.push({
        phase,
        status,
        ...(detail?.taskId ? { taskId: detail.taskId } : {}),
        ...(detail?.message ? { message: detail.message } : {})
      })
    },
    log: () => undefined
  }
  return harness
}

function runContext(harness: Harness, overrides: Partial<WorkflowRunContext> = {}): WorkflowRunContext {
  return {
    host: harness.host,
    request: '调研 Electron IPC 的安全暴露方式',
    startStage: 'brief',
    injectedContext: {},
    abortSignal: new AbortController().signal,
    autoMode: false,
    ...overrides
  }
}

function makeBrief(count: number): ResearchBrief {
  return {
    question: '主问题',
    subQuestions: Array.from({ length: count }, (_, index) => ({
      id: `sub-${index + 1}`,
      question: `子问题 ${index + 1}`
    })),
    successCriteria: ['都有来源'],
    outOfScope: []
  }
}

describe('deep-research workflow', () => {
  it('只暴露 brief 作为起始阶段，并携带路由匹配信号', () => {
    expect(deepResearchWorkflow.name).toBe('deep-research')
    expect(deepResearchWorkflow.stages).toEqual(['brief'])
    expect(deepResearchWorkflow.matchHints.length).toBeGreaterThan(0)
  })

  it('串联四阶段并产出带来源的交付摘要', async () => {
    const harness = makeHarness()
    const result = await deepResearchWorkflow.run(runContext(harness))

    expect(result.status).toBe('completed')
    expect(
      harness.progress.filter((event) => event.status === 'started').map((event) => event.phase)
    ).toEqual(['brief', 'research', 'synthesize', 'review'])
    if (result.status !== 'completed') throw new Error('unreachable')
    expect(result.summary).toContain('通过 contextBridge 暴露类型化白名单方法即可')
    expect(result.summary).toContain('https://www.electronjs.org/docs/latest/api/context-bridge')
    expect(result.summary).toContain('复核结论：pass')
  })

  it('brief 阶段工具清单收窄到只读集合，Auto 关闭时才允许提问', async () => {
    const harness = makeHarness()
    await deepResearchWorkflow.run(runContext(harness))
    const brief = harness.calls.find((call) => call.options?.phase === 'brief')
    expect(brief?.options?.isolation).toBe('shared')
    expect(brief?.options?.tools).toEqual([...READONLY_TOOLS])
    expect(brief?.options?.interactive).toBe(true)

    const autoHarness = makeHarness()
    await deepResearchWorkflow.run(runContext(autoHarness, { autoMode: true }))
    expect(
      autoHarness.calls.find((call) => call.options?.phase === 'brief')?.options?.interactive
    ).toBe(false)
  })

  it('research / synthesize / review 一律只读且不可提问', async () => {
    const harness = makeHarness()
    await deepResearchWorkflow.run(runContext(harness))
    const readonlyPhases = harness.calls.filter((call) =>
      ['research', 'synthesize', 'review'].includes(call.options?.phase ?? '')
    )
    expect(readonlyPhases).toHaveLength(4)
    for (const call of readonlyPhases) {
      expect(call.options?.isolation).toBe('readonly')
      expect(call.options?.interactive).toBe(false)
      expect(call.options?.tools).toBeUndefined()
    }
  })

  it('research 阶段并发发起全部子问题，而不是串行等待', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started = 0
    const harness = makeHarness(async (_prompt, options) => {
      if (options?.phase !== 'research') return null
      started += 1
      // 三个子 agent 都进入后才放行，串行实现会在此死等直到超时
      if (started === 3) release?.()
      await gate
      return FINDING_OUTPUT
    })

    const findings = await runResearch(harness.host, makeBrief(3))
    expect(findings?.answeredIds).toEqual(['sub-1', 'sub-2', 'sub-3'])
    expect(harness.peakConcurrency).toBe(3)
  })

  it('单个子问题失败不连坐其余子问题', async () => {
    const harness = makeHarness(async (prompt, options) => {
      if (options?.phase !== 'research') return null
      if (prompt.includes('sub-2')) throw new Error('装配错误')
      return FINDING_OUTPUT
    })

    const findings = await runResearch(harness.host, makeBrief(3))
    expect(findings).not.toBeNull()
    expect(findings?.answeredIds).toEqual(['sub-1', 'sub-3'])
    expect(findings?.failedIds).toEqual(['sub-2'])
    expect(
      harness.progress.filter((event) => event.status === 'task_failed').map((event) => event.taskId)
    ).toEqual(['sub-2'])
  })

  it('全部子问题失败时阶段失败，不继续综合', async () => {
    const harness = makeHarness(async (_prompt, options) => {
      if (options?.phase === 'brief') return BRIEF_OUTPUT
      return null
    })

    const result = await deepResearchWorkflow.run(runContext(harness))
    expect(result).toEqual({ status: 'failed', reason: 'research failed' })
    expect(harness.calls.some((call) => call.options?.phase === 'synthesize')).toBe(false)
  })

  it('无证据的"已回答"被降级为证据不足，并写入缺口', () => {
    const finding = normalizeFinding(
      { id: 'sub-1', question: '子问题' },
      { status: 'answered', answer: '我认为是这样', evidence: [] }
    )
    expect(finding.status).toBe('inconclusive')
    expect(finding.gaps).toEqual(['未找到可引用来源'])
  })

  it('结论没有任何来源时强制 block，即使模型给了 pass', () => {
    const findings: ResearchFindings = {
      findings: [
        {
          subQuestionId: 'sub-1',
          question: '子问题 1',
          status: 'inconclusive',
          evidence: [],
          gaps: ['没查到']
        }
      ],
      answeredIds: [],
      inconclusiveIds: ['sub-1'],
      failedIds: []
    }
    const synthesis: ResearchSynthesis = {
      conclusion: '大概是这样',
      keyPoints: [],
      conflicts: [],
      unresolved: [],
      recommendations: [],
      citations: []
    }
    const review = normalizeResearchReview(REVIEW_OUTPUT, makeBrief(1), findings, synthesis)
    expect(review?.verdict).toBe('block')
    expect(review?.issues[0]?.severity).toBe('critical')
  })

  it('已取消时不发起任何子 agent', async () => {
    const harness = makeHarness()
    const controller = new AbortController()
    controller.abort()
    const result = await deepResearchWorkflow.run(
      runContext(harness, { abortSignal: controller.signal })
    )
    expect(result).toEqual({ status: 'failed', reason: 'workflow cancelled' })
    expect(harness.calls).toHaveLength(0)
  })

  it('brief 之后被取消则停在 research 之前', async () => {
    const controller = new AbortController()
    const harness = makeHarness(async (_prompt, options) => {
      if (options?.phase === 'brief') {
        controller.abort()
        return BRIEF_OUTPUT
      }
      return null
    })
    const result = await deepResearchWorkflow.run(
      runContext(harness, { abortSignal: controller.signal })
    )
    expect(result).toEqual({ status: 'failed', reason: 'workflow cancelled' })
    expect(harness.calls.every((call) => call.options?.phase === 'brief')).toBe(true)
  })
})
