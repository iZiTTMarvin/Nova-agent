import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunExecutionRegistry } from '../../../../src/runtime/run/RunExecutionRegistry'
import type { ModelClient } from '../../../../src/runtime/model/ModelClient'

const foreground = vi.hoisted(() => ({
  active: false,
  listeners: new Set<() => void>(),
  registry: null as RunExecutionRegistry | null,
  build: vi.fn(async () => ({ ok: true as const }))
}))

vi.mock('../../../../src/main/services/RunCoordinatorHost', () => ({
  getRunCoordinator: () => ({
    subscribe: (listener: () => void) => {
      foreground.listeners.add(listener)
      return () => foreground.listeners.delete(listener)
    }
  }),
  getRunExecutionRegistry: () => foreground.registry
}))
vi.mock('../../../../src/main/agent/state', () => ({
  isAgentTurnInProgress: () => foreground.active || foreground.registry!.hasUnsettledHandle()
}))
vi.mock('../../../../src/main/services/WorkspaceService', () => ({
  getWorkspaceService: () => ({ subscribeWorkspaceRootChanges: () => () => {} })
}))
vi.mock('../../../../src/main/learning/LearningDbHost', () => ({
  ensureLearningDatabaseReady: async () => {},
  getLearningKnowledgeOrNull: () => ({}),
  getLearningKnowledgeReaderOrNull: () => ({})
}))
vi.mock('../../../../src/runtime/learning/build/SkeletonKnowledgeBuild', () => ({
  SkeletonKnowledgeBuild: class { run = foreground.build }
}))

import {
  getLearningBuildState,
  requestLearningBuild,
  shutdownLearningKnowledge
} from '../../../../src/main/learning/LearningKnowledgeHost'

afterEach(async () => {
  await shutdownLearningKnowledge()
  expect(foreground.listeners.size).toBe(0)
  foreground.build.mockClear()
})

describe('大纲生成与前台执行收尾', () => {
  it.each(['queued', 'paused'] as const)('%s 等到句柄清理后自动继续', async state => {
    foreground.registry = new RunExecutionRegistry()
    foreground.active = false
    const model = {} as ModelClient
    if (state === 'paused') requestLearningBuild('/a', model)

    foreground.active = true
    let settle!: () => void
    foreground.registry.register({
      runId: 'foreground', generation: 1, kind: 'agent', abort: () => {},
      settled: new Promise<void>(resolve => { settle = resolve })
    })
    foreground.listeners.forEach(listener => listener())
    if (state === 'queued') requestLearningBuild('/a', model)
    expect(getLearningBuildState('/a').status).toBe(state)
    await Promise.resolve()
    const attempts = foreground.build.mock.calls.length

    // durable 终态先发布，执行清理尚未结束，不能提前放行模型调用。
    foreground.active = false
    foreground.listeners.forEach(listener => listener())
    expect(getLearningBuildState('/a').status).toBe(state)
    expect(foreground.build).toHaveBeenCalledTimes(attempts)

    settle()
    await vi.waitFor(() => expect(foreground.build).toHaveBeenCalledTimes(attempts + 1))
    await vi.waitFor(() => expect(getLearningBuildState('/a')).toEqual({ status: 'idle' }))
  })
})
