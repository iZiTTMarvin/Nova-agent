import type { ModelClient, ChatOptions } from '../../../src/runtime/model/ModelClient'
import type { ChatEvent, ChatMessage, ToolDefinition } from '../../../src/runtime/model/types'
import type { EvidencePackage } from '../../../src/runtime/learning/knowledge/evidence/evidenceTypes'

export class EvidenceAwareMockModelClient implements ModelClient {
  readonly calls: { messages: ChatMessage[]; tools?: ToolDefinition[] }[] = []

  constructor(private readonly buildOutput: (evidence: EvidencePackage) => string) {}

  async *chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    _options?: ChatOptions
  ): AsyncIterable<ChatEvent> {
    this.calls.push({ messages: [...messages], tools: tools ? [...tools] : undefined })
    const raw = String(messages.at(-1)?.content ?? '')
    const payload = JSON.parse(raw) as {
      evidenceFragments: {
        sourceId: string
        path: string
        startLine: number
        endLine: number
        snippet: string
      }[]
      unreadPaths: string[]
    }
    const evidence: EvidencePackage = {
      projectId: 'test',
      workspaceRoot: '',
      strategyVersion: 'learning-evidence-v1',
      fingerprint: '',
      unreadPaths: payload.unreadPaths ?? [],
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
