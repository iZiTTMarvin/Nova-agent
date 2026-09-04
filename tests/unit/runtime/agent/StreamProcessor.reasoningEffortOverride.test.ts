/**
 * 会话思考强度覆盖透传：AgentLoopConfig.reasoningEffort 经 StreamProcessor
 * 注入主对话 modelPool.chat 的 ChatOptions；'auto' 也须原样透传。
 */
import { describe, it, expect } from 'vitest'
import { StreamProcessor } from '../../../../src/runtime/agent/stream/StreamProcessor'
import { ModelClientPool } from '../../../../src/runtime/model/ModelClientPool'
import { RecoveryStateMachine } from '../../../../src/runtime/agent/recovery/RecoveryStateMachine'
import { CacheDiagnostics } from '../../../../src/runtime/model/cacheDiagnostics'
import { HookManager } from '../../../../src/runtime/agent/core/HookManager'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { identitySummaryProjection } from '../../../../src/test-support/builders/identitySummaryProjection'
import type { ChatMessage } from '../../../../src/runtime/model/types'
import type { AgentContext } from '../../../../src/runtime/agent/core/AgentContext'
import type { ModelConfig } from '../../../../src/shared/config'
import type { ReasoningEffort } from '../../../../src/shared/config/llmRegistry'

function createNativeContext(): AgentContext {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    systemPrompt: '',
    toolRegistry: null,
    dialect: 'native',
    mode: 'default',
    workingDir: null,
    shellPath: undefined,
    binDirs: [],
    sessionStore: null,
    sessionId: null,
    artifactStore: null,
    readState: { readFiles: new Set() } as unknown as AgentContext['readState'],
    compactionLevel: 0,
    userTurnsSinceCompaction: 0,
    lastEstimatedTokens: 0,
    compactionState: null,
    skillsTokenBudget: 0
  }
}

async function runOnceAndCaptureOptions(
  reasoningEffort: ReasoningEffort | undefined
): Promise<ReasoningEffort | undefined> {
  const client = new MockModelClient()
  client.addResponse({
    events: [
      { type: 'text_delta', delta: 'ok' },
      { type: 'message_end', finishReason: 'stop' }
    ]
  })
  const stubConfig: ModelConfig = {
    baseUrl: 'http://test',
    apiKey: 'test',
    modelId: 'test-model'
  }
  const processor = new StreamProcessor({
    modelPool: new ModelClientPool({ primary: client, primaryConfig: stubConfig }),
    recovery: new RecoveryStateMachine(),
    cacheDiagnostics: new CacheDiagnostics(),
    emit: () => {},
    emitContextBreakdown: () => {},
    runOverflowCompaction: async () => false,
    hookManager: new HookManager(),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {})
  })

  const result = await processor.run({
    messageId: 'msg_r',
    chatMessages: [{ role: 'user', content: 'hi' }] as ChatMessage[],
    nativeTools: undefined,
    context: createNativeContext(),
    signal: undefined,
    summaryProjection: identitySummaryProjection,
    isCancelled: () => false,
    sleep: () => Promise.resolve()
  })
  expect(result.kind).toBe('assistant')

  const calls = client.getCalls()
  expect(calls).toHaveLength(1)
  return calls[0].options?.reasoningEffort
}

describe('StreamProcessor：会话思考强度覆盖透传', () => {
  it('配置了覆盖值时注入 ChatOptions', async () => {
    expect(await runOnceAndCaptureOptions('max')).toBe('max')
  })

  it('auto 覆盖原样透传，不被丢弃', async () => {
    expect(await runOnceAndCaptureOptions('auto')).toBe('auto')
  })

  it('未配置覆盖时 ChatOptions 不携带该字段', async () => {
    expect(await runOnceAndCaptureOptions(undefined)).toBeUndefined()
  })
})
