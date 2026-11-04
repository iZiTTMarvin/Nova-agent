import type { Mode } from '../session/types'

export type NativeCommandName = 'compact' | 'init' | 'plan'
export type NativeCommandExecution = 'agent' | 'compact' | 'local'

export interface NativeCommandDefinition {
  name: NativeCommandName
  description: string
  execution: NativeCommandExecution
  acceptsArguments: boolean
}

/** 菜单、发送校验与执行路由共用的原生命令目录。 */
export const NATIVE_COMMANDS: readonly NativeCommandDefinition[] = [
  {
    name: 'compact',
    description: '立即压缩当前会话上下文',
    execution: 'compact',
    acceptsArguments: false
  },
  {
    name: 'init',
    description: '检查工作区并创建或更新 AGENTS.md，可附补充要求',
    execution: 'agent',
    acceptsArguments: true
  },
  {
    name: 'plan',
    description: '切换到只读规划模式',
    execution: 'local',
    acceptsArguments: false
  }
]

export interface NativeCommandInvocation {
  command: NativeCommandDefinition
  args: string
}

export interface NativeCommandRejection {
  type: 'command'
  commandName: NativeCommandName
  reason: 'invalid_arguments' | 'mode_not_allowed' | 'unsupported_action'
  message: string
}

export interface NativeCommandCompletion {
  commandName: NativeCommandName
}

export function parseNativeCommand(input: string): NativeCommandInvocation | null {
  const match = /^\/(\S+?)(?:\s+(.*))?$/.exec(input.trim())
  if (!match?.[1]) return null
  const command = NATIVE_COMMANDS.find(candidate => candidate.name === match[1])
  if (!command) return null
  return { command, args: match[2]?.trim() ?? '' }
}

export function validateNativeCommand(
  invocation: NativeCommandInvocation,
  context: { mode: Mode; regenerate?: boolean; hasImages?: boolean }
): NativeCommandRejection | null {
  const { command, args } = invocation
  const reject = (
    reason: NativeCommandRejection['reason'],
    message: string
  ): NativeCommandRejection => ({
    type: 'command',
    commandName: command.name,
    reason,
    message
  })

  if (context.regenerate) {
    return reject('unsupported_action', `命令 /${command.name} 的结果不支持重新生成`)
  }
  if (context.hasImages) {
    return reject('invalid_arguments', `命令 /${command.name} 不支持图片输入`)
  }
  if (args && !command.acceptsArguments) {
    return reject('invalid_arguments', `命令 /${command.name} 不接受参数`)
  }
  if (command.name === 'init' && context.mode === 'plan') {
    return reject(
      'mode_not_allowed',
      '规划模式为只读，不能创建或更新 AGENTS.md；请退出规划模式后重试'
    )
  }
  return null
}
