/**
 * invoke_skill 工具 — 在主对话注入技能，fork 时委托 durable child 执行端口。
 */
import type { SkillRegistry } from '../skills/SkillRegistry'
import { invokeSkillForTool } from '../skills/invokeSkill'
import { runSkillFork } from '../skills/runSkillFork'
import type { SkillManifest } from '../skills/types'
import type { ToolExecutor, ToolContext, ToolResult } from './types'
import type { SpawnSubagentPort } from '../subagents'

export interface InvokeSkillToolDeps {
  skillRegistry: SkillRegistry
  getSpawnSubagentPort: () => SpawnSubagentPort | undefined
  /**
   * skill 展开成功后回调，宿主用它把 skill.directory 注册为可读根。
   * 写入口在 AgentLoop.addSkillRoot，不接受模型参数直接注入。
   */
  onSkillInvoked?: (skill: SkillManifest) => void
}

/**
 * 创建 invoke_skill 工具实例
 */
export function createInvokeSkillTool(deps: InvokeSkillToolDeps): ToolExecutor {
  return {
    name: 'invoke_skill',
    description: '调用一个已注册的技能；普通技能注入当前对话，fork 技能在独立 Child Session 中执行。',
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

      const result = invokeSkillForTool(skillName, task, deps.skillRegistry, {
        workspacePath: ctx.workingDir,
        arguments: task
      })

      if (!result.success) {
        return { success: false, output: '', error: result.error }
      }

      // fork skill：隔离子代理执行
      if (result.fork) {
        if (!ctx.sessionId || !ctx.runId || !ctx.invocationRef) {
          return {
            success: false,
            output: '',
            error: 'invoke_skill fork 缺少 durable tool invocation identity'
          }
        }
        const forkResult = await runSkillFork({
          getSpawnSubagentPort: deps.getSpawnSubagentPort
        }, {
          skill: result.fork,
          args: task,
          parentSessionId: ctx.sessionId,
          parentRunId: ctx.runId,
          parentMessageId: ctx.invocationRef.messageId,
          parentToolCallId: ctx.invocationRef.toolCallId,
          workingDirectory: ctx.workingDir,
          invocationRef: ctx.invocationRef,
          ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
          templateContext: {
            workspacePath: ctx.workingDir,
            arguments: task,
            skillDirectory: result.fork.directory
          }
        })
        if (!forkResult.success) {
          return {
            success: false,
            output: '',
            error: forkResult.summary
          }
        }
        return { success: true, output: forkResult.summary }
      }

      if (result.skill) deps.onSkillInvoked?.(result.skill)
      return { success: true, output: result.output }
    }
  }
}
