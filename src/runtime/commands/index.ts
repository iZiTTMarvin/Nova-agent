import type { NativeCommandInvocation } from '../../shared/commands'

export interface NativeCommandAgentDispatch {
  kind: 'command'
  userContent: string
}

export type NativeCommandRuntimeDispatch =
  | NativeCommandAgentDispatch
  | { kind: 'compact' }
  | { kind: 'plan' }

function buildInitInstruction(args: string): string {
  const instruction = [
    '请真实检查当前工作区，然后创建或更新工作区根目录的 AGENTS.md，帮助后续 Agent 理解项目结构、开发命令与协作约定。',
    '',
    '要求：',
    '- 先读取实际目录、项目清单、配置和现有文档，不得凭猜测写入项目事实。',
    '- 只能创建或更新工作区根目录的 AGENTS.md，不得创建或修改任何其他文件。',
    '- 如果根 AGENTS.md 已存在，保留仍然准确有效的内容，只修正过时部分并补充必要信息，不要无条件覆盖整份文件。',
    '- 完成后核对内容与变更范围，确保没有改动其他文件。'
  ]
  if (args) {
    instruction.push('', '用户补充要求（同样受上述文件范围约束）：', args)
  }
  return instruction.join('\n')
}

/** 原生命令只解析执行意图；实际压缩与本地模式切换由各自 Owner 执行。 */
export function resolveNativeCommandDispatch(
  invocation: NativeCommandInvocation
): NativeCommandRuntimeDispatch {
  switch (invocation.command.name) {
    case 'compact':
      return { kind: 'compact' }
    case 'plan':
      return { kind: 'plan' }
    case 'init':
      return { kind: 'command', userContent: buildInitInstruction(invocation.args) }
  }
}
