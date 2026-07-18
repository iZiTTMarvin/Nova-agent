import { describe, expect, it, vi } from 'vitest'
import { executeToolBatch } from '../../../../../src/runtime/agent/execution/toolBatchExecutor'
import { ToolRegistry } from '../../../../../src/runtime/tools/ToolRegistry'
import type { ToolExecutor } from '../../../../../src/runtime/tools/types'
import {
  authorizeXForgeToolCall,
  authorizeXForgeVerificationCommand,
  getXForgeEffectiveToolDefinitions,
  getXForgeMainAgentModeInstruction,
  getXForgeToolEffect
} from '../../../../../src/runtime/workflow/xforge/policy'
import type { XForgeValidatedPlan } from '../../../../../src/runtime/workflow/xforge/plan'
import type { XForgeStage } from '../../../../../src/runtime/workflow/xforge/types'

const PLAN: XForgeValidatedPlan = {
  version: 1,
  goal: '收敛权限契约',
  constraints: ['不自动 commit'],
  nonGoals: ['不发布'],
  repositoryFacts: ['存在 TypeScript 工具链'],
  changeScope: ['src/allowed', 'package.json'],
  tasks: [{ id: 'T1', title: '实现 policy', acceptance: ['policy 单测通过'] }],
  acceptanceMap: { T1: ['policy 单测通过'] },
  verificationChecklist: ['npm run typecheck'],
  risks: ['权限规则分裂']
}

const MATRIX_TOOLS = ['read', 'edit', 'write', 'bash', 'task', 'invoke_skill', 'askQuestion', 'unknown']
const PRE_WRITE_STAGES: XForgeStage[] = ['resolve', 'brainstorm', 'plan', 'scope_check']
const WRITE_STAGES: XForgeStage[] = ['implement', 'fix']
const NON_MAIN_AGENT_STAGES: XForgeStage[] = [
  'test',
  'review',
  'report',
  'waiting_user',
  'completed',
  'failed',
  'cancelled'
]

function authorize(stage: XForgeStage, toolName: string, args: Record<string, unknown> = {}) {
  return authorizeXForgeToolCall({
    stage,
    workspaceRoot: process.cwd(),
    validatedPlan: PLAN,
    toolName,
    args
  })
}

function tool(name: string): ToolExecutor {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    executionMode: 'sequential',
    async execute() {
      return { success: true, output: `${name} executed` }
    }
  }
}

describe('XForge execution policy', () => {
  it('明确分类矩阵中的工具效果', () => {
    expect(Object.fromEntries(MATRIX_TOOLS.map(name => [name, getXForgeToolEffect(name)]))).toEqual({
      read: 'readonly',
      edit: 'workspace_write',
      write: 'workspace_write',
      bash: 'shell',
      task: 'orchestration',
      invoke_skill: 'orchestration',
      askQuestion: 'user_interaction',
      unknown: 'unknown'
    })
  })

  it('pre-write 阶段只允许读取，拒绝所有写入、shell、编排、交互和未知工具', () => {
    for (const stage of PRE_WRITE_STAGES) {
      expect(authorize(stage, 'read').allowed).toBe(true)
      expect(authorize(stage, 'edit', { path: 'src/allowed/file.ts' }).allowed).toBe(false)
      expect(authorize(stage, 'write', { path: 'src/allowed/file.ts' }).allowed).toBe(false)
      expect(authorize(stage, 'bash', { command: 'npm test' }).allowed).toBe(false)
      expect(authorize(stage, 'task').allowed).toBe(false)
      expect(authorize(stage, 'invoke_skill').allowed).toBe(false)
      expect(authorize(stage, 'askQuestion').allowed).toBe(false)
      expect(authorize(stage, 'unknown').allowed).toBe(false)
    }
  })

  it('implement/fix 阶段允许 scope 内读写，拒绝 bash、编排、交互和未知工具', () => {
    for (const stage of WRITE_STAGES) {
      expect(authorize(stage, 'read').allowed).toBe(true)
      expect(authorize(stage, 'edit', { filePath: 'src/allowed/file.ts' }).allowed).toBe(true)
      expect(authorize(stage, 'write', { path: 'package.json' }).allowed).toBe(true)
      expect(authorize(stage, 'write', { path: 'src/outside/file.ts' }).allowed).toBe(false)
      expect(authorize(stage, 'bash', { command: 'npm test' }).allowed).toBe(false)
      expect(authorize(stage, 'task').allowed).toBe(false)
      expect(authorize(stage, 'invoke_skill').allowed).toBe(false)
      expect(authorize(stage, 'askQuestion').allowed).toBe(false)
      expect(authorize(stage, 'unknown').allowed).toBe(false)
    }
  })

  it('schema exposure 与授权分离，implement/fix 只暴露读写工具', () => {
    const definitions = MATRIX_TOOLS.map(name => ({
      name,
      description: `${name} tool`,
      parameters: { type: 'object', properties: {} }
    }))

    expect(getXForgeEffectiveToolDefinitions({
      stage: 'plan',
      toolDefinitions: definitions
    }).map(def => def.name)).toEqual(['read'])

    expect(getXForgeEffectiveToolDefinitions({
      stage: 'implement',
      toolDefinitions: definitions
    }).map(def => def.name)).toEqual(['read', 'edit', 'write'])

    for (const stage of NON_MAIN_AGENT_STAGES) {
      expect(getXForgeEffectiveToolDefinitions({
        stage,
        toolDefinitions: definitions
      }).map(def => def.name)).toEqual([])
    }
  })

  it('XForge 主 Agent 模式说明与 policy 暴露和授权边界一致', () => {
    const planInstruction = getXForgeMainAgentModeInstruction('plan')
    expect(planInstruction).toContain('只能读取和分析工作区')
    expect(planInstruction).toContain('不能调用 edit/write')
    expect(planInstruction).toContain('主 Agent 永远不能执行 bash、task、invoke_skill 或 askQuestion')
    expect(planInstruction).not.toContain('可以读取、修改和验证工作区')
    expect(planInstruction).not.toContain('askQuestion / askUser')

    const implementInstruction = getXForgeMainAgentModeInstruction('implement')
    expect(implementInstruction).toContain('validated changeScope 内调用 edit/write')
    expect(implementInstruction).toContain('测试、验证、用户提问和阶段推进由 Runtime 控制')
    expect(implementInstruction).not.toContain('可以读取、修改和验证工作区')
    expect(implementInstruction).not.toContain('askQuestion / askUser')
  })

  it('Test Gate verification policy 独立允许验证命令并拒绝副作用命令', () => {
    expect(authorizeXForgeVerificationCommand('npm run typecheck').allowed).toBe(true)
    expect(authorizeXForgeVerificationCommand('node --test smoke.test.mjs').allowed).toBe(true)
    expect(authorizeXForgeVerificationCommand('npm test && git push').allowed).toBe(false)
    expect(authorizeXForgeVerificationCommand('git push').allowed).toBe(false)
    expect(authorizeXForgeVerificationCommand('node -e "require(\'fs\').writeFileSync(\'owned\',\'1\')"').allowed).toBe(false)
  })

  it('tool-call authorization 使用 preToolUse 修改后的最终参数', async () => {
    const registry = new ToolRegistry()
    registry.register(tool('write'))

    const emitted: unknown[] = []
    const checkedArgs: Record<string, unknown>[] = []
    const hookManager = {
      trigger: vi.fn(async payload => {
        if (payload.event === 'preToolUse') {
          return { modifiedArgs: { path: 'src/outside/file.ts' } }
        }
        return undefined
      })
    } as any

    await executeToolBatch({
      toolCalls: [{ id: 'write-1', name: 'write', arguments: '{"path":"src/allowed/file.ts","content":"ok"}' }],
      messageId: 'msg-xforge-policy',
      toolRegistry: registry,
      workingDir: process.cwd(),
      mode: 'compose',
      supportsVision: true,
      checkpointManager: null,
      abortSignal: undefined,
      checkPermission: async (toolName, args) => {
        checkedArgs.push(args)
        const decision = authorizeXForgeToolCall({
          stage: 'implement',
          workspaceRoot: process.cwd(),
          validatedPlan: PLAN,
          toolName,
          args
        })
        return { allowed: decision.allowed, reason: decision.reason }
      },
      emit: event => emitted.push(event),
      applyTruncation: output => output,
      maxParallelToolCalls: 1,
      toolExecution: 'sequential',
      hookManager
    })

    expect(checkedArgs).toEqual([expect.objectContaining({ path: 'src/outside/file.ts' })])
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool_result',
        result: expect.stringContaining('changeScope')
      })
    ]))
  })
})
