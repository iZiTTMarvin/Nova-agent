import type { ModelClient, ChatOptions } from '../../../src/runtime/model/ModelClient'
import type { ChatEvent, ChatMessage, ToolDefinition } from '../../../src/runtime/model/types'
import type { RequestBudgetMeasurement } from '../../../../src/runtime/model/requestBudget'
import type { EvidencePackage } from '../../../src/runtime/learning/knowledge/evidence/evidenceTypes'
import { estimateTextTokens } from '../../../../src/shared/model/tokenEstimate'

/** 读取请求里的证据包并按回调生成编译输出；可声明上下文窗口以驱动预算。 */
export class EvidenceAwareMockModelClient implements ModelClient {
  readonly calls: { messages: ChatMessage[]; tools?: ToolDefinition[] }[] = []

  constructor(
    private readonly buildOutput: (evidence: EvidencePackage) => string,
    private readonly contextWindow?: number
  ) {}

  measureRequest(messages: ChatMessage[]): RequestBudgetMeasurement {
    return {
      routeId: 'mock',
      tokenizerId: 'unknown',
      contextWindow: this.contextWindow ?? 200_000,
      envelopeHash: '',
      prefixHashes: [],
      serializedBytes: 0,
      budgetUnits: estimateTextTokens(JSON.stringify(messages))
    }
  }

  async *chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    _options?: ChatOptions
  ): AsyncIterable<ChatEvent> {
    this.calls.push({ messages: [...messages], tools: tools ? [...tools] : undefined })
    const raw = String(messages[0]?.content ?? '')
    const payload = JSON.parse(raw) as {
      evidenceFragments: {
        sourceId: string
        path: string
        startLine: number
        endLine: number
        snippet: string
      }[]
      projectLayout: { dir: string; fileCount: number }[]
    }
    const evidence: EvidencePackage = {
      projectId: 'test',
      workspaceRoot: '',
      strategyVersion: 'learning-evidence-v2',
      fingerprint: '',
      projectLayout: payload.projectLayout ?? [],
      fragments: (payload.evidenceFragments ?? []).map(f => ({
        sourceId: f.sourceId,
        relativePath: f.path,
        startLine: f.startLine,
        endLine: f.endLine,
        snippetText: f.snippet,
        contentHash: '',
        snippetHash: '',
        symbolLabel: null,
        collectedAt: 0
      }))
    }
    yield { type: 'text_delta', delta: this.buildOutput(evidence) }
  }

  updateConfig(): void {
    // noop
  }
}
