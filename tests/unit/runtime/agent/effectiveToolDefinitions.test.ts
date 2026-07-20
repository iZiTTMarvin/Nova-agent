import { describe, expect, it } from 'vitest'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import type { ChatEvent, ToolDefinition } from '../../../../src/runtime/model/types'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import type { ToolExecutor } from '../../../../src/runtime/tools/types'

function tool(name: string): ToolExecutor {
  return {
    name,
    description: `${name} exposed tool`,
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    executionMode: 'sequential',
    async execute() {
      return { success: true, output: `${name} ok` }
    }
  }
}

describe('AgentLoop effective tool definitions', () => {
  it('模型 tools、cache diagnostics 和 context breakdown 使用同一份 effective definitions', async () => {
    const registry = new ToolRegistry()
    registry.register(tool('read'))
    registry.register(tool('bash'))

    async function run(filterTools: boolean): Promise<{
      modelTools: string[]
      toolsHash: string | null
      toolsTokens: number
      cacheDiagnostics: unknown[]
    }> {
      const events: any[] = []
      const bus = new EventBus()
      bus.on(event => events.push(event))
      let modelTools: ToolDefinition[] | undefined

      const client = {
        config: { modelId: 'gpt-4o', baseUrl: '' },
        async *chat(_messages: unknown, tools?: ToolDefinition[]): AsyncIterable<ChatEvent> {
          modelTools = tools
          yield {
            type: 'wire_snapshot',
            snapshot: {
              model: 'gpt-4o',
              toolsHash: `th-${tools?.map(tool => tool.name).join('-') ?? 'none'}`,
              semanticMessageHashes: [],
              exactBodyHash: 'exact'
            }
          }
          yield {
            type: 'usage',
            usage: {
              promptTokens: 100,
              completionTokens: 1,
              totalTokens: 101,
              cachedTokens: 100
            }
          }
          yield { type: 'message_end', finishReason: 'stop' }
        },
        updateConfig() {}
      }

      const loop = new AgentLoop(client as any, bus, { systemPrompt: 'system', toolDialectOverride: 'native' })
      loop.setToolRegistry(registry)
      if (filterTools) {
        loop.setEffectiveToolDefinitionsProvider(() =>
          registry.getToolDefinitions().filter(definition => definition.name === 'read')
        )
      }

      await loop.sendMessage('hello')

      const breakdown = events.find(event => event.type === 'context_breakdown')
      const cacheDiagnostics = events.filter(event => event.type === 'cache_diagnostic')
      const cache = (loop as unknown as {
        cacheDiagnostics: { getLastWireSnapshot(): { toolsHash: string } | null }
      }).cacheDiagnostics
      const snapshot = cache.getLastWireSnapshot()
      const result = {
        modelTools: modelTools?.map(tool => tool.name) ?? [],
        toolsHash: snapshot?.toolsHash ?? null,
        toolsTokens: breakdown?.breakdown.tools ?? 0,
        cacheDiagnostics
      }
      loop.dispose()
      return result
    }

    const filtered = await run(true)
    const unfiltered = await run(false)

    expect(filtered.modelTools).toEqual(['read'])
    expect(filtered.toolsHash).toBe('th-read')
    expect(filtered.toolsTokens).toBeGreaterThan(0)
    expect(filtered.toolsTokens).toBeLessThan(unfiltered.toolsTokens)
    expect(filtered.cacheDiagnostics).toEqual([])

    expect(unfiltered.modelTools).toEqual(['read', 'bash'])
    expect(unfiltered.toolsHash).toBe('th-read-bash')
  })
})
