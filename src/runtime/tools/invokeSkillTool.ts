/**
 * invoke_skill 工具 — 在主对话上下文中展开技能 body（v2 统一调度）
 * flag=false 时保留旧行为：独立 modelClient.chat
 */
import type { ModelClient } from '../model/ModelClient'
import type { SkillRegistry } from '../skills/SkillRegistry'
import { invokeSkillForTool } from '../skills/invokeSkill'
import { runSkillFork, type RunSkillForkDeps } from '../skills/runSkillFork'
import type { EventBus } from '../agent/EventBus'
import type { ToolExecutor, ToolContext, ToolResult } from './types'

export interface InvokeSkillToolDeps {
  modelClient: ModelClient
  skillRegistry: SkillRegistry
  /** 默认 true：展开 body 注入主对话，不独立开 chat */
  useUnifiedSkillDispatch?: boolean
  /** fork skill 时需要 */
  parentEventBus?: EventBus
  resolveTool?: (name: string) => ToolExecutor | undefined
  contextWindow?: number
  supportsVision?: boolean
}

/**
 * 创建 invoke_skill 工具实例
 */
export function createInvokeSkillTool(deps: InvokeSkillToolDeps): ToolExecutor {
  const useUnified = deps.useUnifiedSkillDispatch !== false

  return {
    name: 'invoke_skill',
    description: '调用一个已注册的技能。技能内容将注入当前对话上下文，由主模型按技能说明执行。',
    parameters: {
      type: 'object',
      properties: {
        skill_name: { type: 'string', description: '技能名称（不含路径）' },
        task: { type: 'string', description: '传给技能的具体任务描述' }
      },
      required: ['skill_name', 'task']
    },
    executionMode: 'sequential',
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const skillName = String(args.skill_name ?? '')
      const task = String(args.task ?? '')

      // 旧路径：独立 chat（仅 flag=false）
      if (!useUnified) {
        return executeLegacyChat(deps, skillName, task)
      }

      const result = invokeSkillForTool(skillName, task, deps.skillRegistry, {
        workspacePath: ctx.workingDir,
        arguments: task
      })

      if (!result.success) {
        return { success: false, output: '', error: result.error }
      }

      // fork skill：隔离子代理执行
      if (result.fork && deps.parentEventBus && deps.resolveTool) {
        const forkDeps: RunSkillForkDeps = {
          modelClient: deps.modelClient,
          parentEventBus: deps.parentEventBus,
          resolveTool: deps.resolveTool,
          contextWindow: deps.contextWindow,
          supportsVision: deps.supportsVision
        }
        const forkResult = await runSkillFork(forkDeps, {
          skill: result.fork,
          args: task,
          ctx,
          templateContext: { workspacePath: ctx.workingDir, arguments: task }
        })
        return {
          success: forkResult.success,
          output: forkResult.summary
        }
      }

      return { success: true, output: result.output }
    }
  }
}

/** 旧版独立 chat 调用（useUnifiedSkillDispatch=false） */
async function executeLegacyChat(
  deps: InvokeSkillToolDeps,
  skillName: string,
  task: string
): Promise<ToolResult> {
  const skill = deps.skillRegistry.get(skillName)
  if (!skill) {
    return { success: false, output: '', error: `技能 "${skillName}" 未找到` }
  }

  const systemContent = `${skill.body}\n\n---\n\n请完成以下任务并给出简洁摘要：`
  const messages = [
    { role: 'system' as const, content: systemContent },
    { role: 'user' as const, content: task }
  ]

  let output = ''
  try {
    const stream = deps.modelClient.chat(messages)
    for await (const event of stream) {
      if (event.type === 'text_delta') output += event.delta
      if (event.type === 'error') {
        return { success: false, output: '', error: event.error }
      }
    }
  } catch (err) {
    return { success: false, output: '', error: (err as Error).message }
  }

  if (!output.trim()) {
    return { success: false, output: '', error: '技能执行未返回内容' }
  }
  return { success: true, output: output.trim() }
}
