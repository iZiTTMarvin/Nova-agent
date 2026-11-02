/**
 * 真实 API：稳定前缀 → load_tools 激活 → 激活后请求 → 后续稳定请求。
 *
 * 显式运行、key 门控、会花钱。默认套件与 CI 不包含。
 * 本文件不把 cacheRead > 0 当成通过条件：少量基线命中可能掩盖整段历史失效。
 * Anthropic 显式 marker 不在当前 live provider 集合内，仍以本地 raw-body 单测为准。
 */
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { AgentLoop, EventBus } from '../../src/runtime/agent'
import { agentRoute } from '../../src/runtime/agent/turn'
import { OpenAICompatibleModelClient } from '../../src/runtime/model/OpenAICompatibleModelClient'
import { ToolRegistry } from '../../src/runtime/tools/ToolRegistry'
import { ToolAvailability } from '../../src/runtime/tools/availability'
import { createLoadToolsTool } from '../../src/runtime/tools/loadTools'
import { listGroupToolNames } from '../../src/runtime/tools/catalog'
import { readTool } from '../../src/runtime/tools/readTool'
import { lsTool } from '../../src/runtime/tools/lsTool'
import { ArtifactStore } from '../../src/runtime/artifacts/ArtifactStore'
import { PermissionManager } from '../../src/runtime/permissions/PermissionManager'
import { projectBaselineToolDefinitions } from '../../src/runtime/agent/core/AgentContext'
import { renderToolInventory } from '../../src/runtime/agent/promptBuilder/toolPromptRenderer'
import type { ToolResult } from '../../src/runtime/tools/types'
import type { ModelClientConfig } from '../../src/runtime/model/types'
import {
  CapturingModelClient,
  createGateWorkspace,
  formatRequestsTable,
  GATE_SYSTEM_PROMPT,
  resolveLiveProvider,
  type LiveProviderId
} from './gate'

const PROVIDER_IDS: LiveProviderId[] = ['deepseek', 'glm', 'kimi', 'minimax']

function classifyToolNames(
  previous: readonly string[],
  current: readonly string[]
): 'unchanged' | 'append' | 'rewrite' {
  if (previous.length === current.length && previous.every((name, index) => name === current[index])) {
    return 'unchanged'
  }
  if (previous.length <= current.length && previous.every((name, index) => name === current[index])) {
    return 'append'
  }
  return 'rewrite'
}

function stubDeferred(name: string) {
  return {
    name,
    description: `${name} dry-run stub`,
    parameters: { type: 'object' as const, properties: {} },
    async execute(): Promise<ToolResult> {
      return { success: true, output: `${name} dry-run` }
    }
  }
}

describe.each(PROVIDER_IDS)('真实 API 工具激活前缀：%s', providerId => {
  const provider = resolveLiveProvider(providerId)

  describe.skipIf(!provider)('稳定前缀后激活 deferred 组', () => {
    it(
      '稳定请求 → load_tools → 激活后请求 → 再稳定：本地 tools 分类为 append/unchanged',
      async () => {
        const workspace = createGateWorkspace({
          'notes/alpha.txt': 'alpha 前缀缓存说明\n'
        })
        const availability = new ToolAvailability()
        availability.setEconomyMode('on')
        const registry = new ToolRegistry()
        registry.register(readTool)
        registry.register(lsTool)
        for (const name of listGroupToolNames('agent')) {
          registry.register(stubDeferred(name))
        }
        const registeredToolNames = registry.getToolDefinitions().map(def => def.name)
        registry.register(
          createLoadToolsTool({
            getAvailability: () => availability,
            registeredToolNames
          })
        )
        availability.bindRegisteredToolNames(registry.getToolDefinitions().map(def => def.name))
        const baseline = projectBaselineToolDefinitions(
          'default',
          registry.getToolDefinitions(),
          availability
        )

        const clientConfig: ModelClientConfig = {
          apiKey: provider!.apiKey,
          baseUrl: provider!.baseUrl,
          modelId: provider!.modelId,
          cacheProfile: provider!.cacheProfileId,
          supportsVision: false
        }
        const inner = new OpenAICompatibleModelClient(clientConfig)
        const client = new CapturingModelClient(inner, clientConfig)
        const eventBus = new EventBus()
        let loadToolsCalls = 0
        eventBus.on(event => {
          if (event.type === 'tool_call' && event.toolName === 'load_tools') loadToolsCalls++
        })

        const loop = new AgentLoop(client, eventBus, {
          systemPromptLayers: {
            agentRole: GATE_SYSTEM_PROMPT,
            toolSummary: renderToolInventory(baseline, { dialect: 'native' })
          },
          contextWindow: 128_000,
          supportsVision: false,
          permissionMode: 'full_access',
          permissionManager: new PermissionManager(),
          maxToolRounds: 8,
          promptCacheKey: randomUUID()
        })
        loop.setToolRegistry(registry)
        loop.setToolAvailability(availability)
        loop.setSessionId(randomUUID())
        loop.setArtifactStore(new ArtifactStore(join(workspace, '.nova-gate-sessions')))
        loop.setWorkingDir(workspace)
        loop.setWorkspaceRoot(workspace)
        loop.setMode('default')

        try {
          const outcome1 = await loop.sendMessage(
            '请只调用 load_tools，参数 group 必须是 agent。成功后用一句话确认成员名单，不要再调用其他工具。',
            agentRoute()
          )
          if (outcome1.status !== 'completed') {
            throw new Error(`激活轮失败: ${outcome1.status}`)
          }
          const outcome2 = await loop.sendMessage(
            '不要再调用 load_tools。用一句话复述刚才激活的工具组名称。',
            agentRoute()
          )
          if (outcome2.status !== 'completed') {
            throw new Error(`稳定轮失败: ${outcome2.status}`)
          }
        } finally {
          loop.dispose()
        }

        const main = client.getRequests().filter(request => request.purpose === 'main')
        expect(
          loadToolsCalls,
          `模型未调用 load_tools，无法验证激活前缀\n${formatRequestsTable(client.getRequests())}`
        ).toBeGreaterThanOrEqual(1)
        expect(main.length).toBeGreaterThanOrEqual(3)

        const classifications = main.slice(1).map((request, index) => ({
          from: main[index].index,
          to: request.index,
          kind: classifyToolNames(main[index].toolNames, request.toolNames),
          prevTools: main[index].toolNames.length,
          nextTools: request.toolNames.length,
          cacheRead: request.usage?.cacheReadTokens,
          cacheWrite: request.usage?.cacheWriteTokens,
          uncached: request.usage?.uncachedInputTokens,
          output: request.usage?.outputTokens,
          cacheReadReport: request.usage?.cacheReadReport
        }))

        expect(
          classifications.some(item => item.kind === 'append'),
          `激活未表现为 tools 尾部追加：${JSON.stringify(classifications)}\n${formatRequestsTable(client.getRequests())}`
        ).toBe(true)
        expect(
          classifications.every(item => item.kind === 'append' || item.kind === 'unchanged'),
          `出现非追加工具变化：${JSON.stringify(classifications)}\n${formatRequestsTable(client.getRequests())}`
        ).toBe(true)

        const last = classifications.at(-1)
        expect(last?.kind, '激活后的稳定请求不得再改写 tools').toBe('unchanged')
      },
      300_000
    )
  })
})
