/**
 * invoke_skill 工具 — 在干净上下文中执行技能 body
 */
import type { ModelClient } from '../model/ModelClient'
import type { SkillRegistry } from '../skills/SkillRegistry'
import type { ToolExecutor, ToolContext, ToolResult } from './types'

export interface InvokeSkillToolDeps {
  modelClient: ModelClient
  skillRegistry: SkillRegistry
}

/**
 * 创建 invoke_skill 工具实例
 * @param deps 模型客户端与技能注册表
 */
export function createInvokeSkillTool(deps: InvokeSkillToolDeps): ToolExecutor {
  return {
    name: 'invoke_skill',
    description: '调用一个已注册的技能。技能在干净上下文中执行其 body 描述的工作，返回摘要结果。',
    parameters: {
      type: 'object',
      properties: {
        skill_name: { type: 'string', description: '技能名称（不含路径）' },
        task: { type: 'string', description: '传给技能的具体任务描述' }
      },
      required: ['skill_name', 'task']
    },
    executionMode: 'sequential',
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      const skillName = String(args.skill_name ?? '')
      const task = String(args.task ?? '')
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
  }
}
