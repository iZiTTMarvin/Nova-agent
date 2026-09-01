/** Skill fork 只负责构造 durable child 命令，执行生命周期归统一子代理端口。 */
import { SUBAGENT_WALL_CLOCK_TIMEOUT_MS, type SpawnSubagentPort } from '../subagents'
import type { ToolInvocationRef } from '../tools/types'
import type { SpawnSubagentCommand, SubagentOrigin } from '../../shared/subagents'
import { expandTemplate } from './template'
import type { SkillManifest, TemplateContext } from './types'

const DEFAULT_TOOLS = [
  'ls',
  'read',
  'grep',
  'find',
  'edit',
  'write',
  'bash',
  'todo_write'
] as const
const WRITE_TOOLS = new Set(['edit', 'write', 'bash', 'save_plan', 'switch_mode'])

export interface RunSkillForkDeps {
  getSpawnSubagentPort: () => SpawnSubagentPort | undefined
}

export interface RunSkillForkParams {
  skill: SkillManifest
  args: string
  parentSessionId: string
  parentRunId: string
  parentMessageId: string
  parentToolCallId?: string
  workingDirectory: string
  abortSignal?: AbortSignal
  invocationRef?: ToolInvocationRef
  templateContext?: TemplateContext
}

function resolveTools(skill: SkillManifest): string[] {
  const forbidden = new Set(skill.forbiddenTools ?? [])
  const source = skill.allowedTools?.length ? skill.allowedTools : [...DEFAULT_TOOLS]
  return [...new Set(source.filter((name) => !forbidden.has(name)))]
}

function buildProfile(
  skill: SkillManifest,
  systemPrompt: string,
  tools: readonly string[]
): { profileId: string; profile: Record<string, unknown> } {
  const profileId = skill.name
  return {
    profileId,
    profile: {
      id: profileId,
      name: profileId,
      description: `Durable fork for skill ${skill.name}`,
      prompt: systemPrompt,
      allowedTools: [...tools],
      skillRoots: [skill.directory]
    }
  }
}

function buildOrigin(params: RunSkillForkParams): SubagentOrigin {
  return {
    kind: 'skill_fork',
    parentMessageId: params.parentMessageId,
    ...(params.parentToolCallId ? { parentToolCallId: params.parentToolCallId } : {}),
    skillName: params.skill.name
  }
}

/** 以独立 Child Session 执行 fork skill，返回给父消息的有界摘要。 */
export async function runSkillFork(
  deps: RunSkillForkDeps,
  params: RunSkillForkParams
): Promise<{ success: boolean; summary: string }> {
  const port = deps.getSpawnSubagentPort()
  if (!port) return { success: false, summary: '统一子代理执行端口未装配' }

  const { content: skillBody } = expandTemplate(params.skill.body, {
    ...(params.templateContext ?? {}),
    arguments: params.args,
    skillDirectory: params.skill.directory
  })
  const tools = resolveTools(params.skill)
  const { profileId, profile } = buildProfile(params.skill, skillBody, tools)
  const isolation = tools.some((name) => WRITE_TOOLS.has(name)) ? 'shared' : 'readonly'
  const command: SpawnSubagentCommand = {
    parentSessionId: params.parentSessionId,
    parentRunId: params.parentRunId,
    invocation: buildOrigin(params),
    profileId,
        task: params.args.trim() || '按技能说明执行',
        workingDirectory: params.workingDirectory,
        isolation,
        timeoutMs: SUBAGENT_WALL_CLOCK_TIMEOUT_MS
      }

  try {
    const result = await port.spawn(command, {
      profile,
      ...(params.invocationRef ? { invocationRef: params.invocationRef } : {}),
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {})
    })
    if (result.status !== 'completed') {
      return {
        success: false,
        summary: result.failure?.message ?? `技能子代理已${result.status}`
      }
    }
    return { success: true, summary: result.summary }
  } catch (error) {
    return {
      success: false,
      summary: error instanceof Error ? error.message : String(error)
    }
  }
}
