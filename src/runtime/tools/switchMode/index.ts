import type { ToolExecutor } from '../types'

export const switchModeTool: ToolExecutor = {
  name: 'switch_mode',
  description:
    '在同一会话中切换 plan 与 default 模式。' +
    '进入 plan 会立即在当前任务中继续规划；从 plan 返回 default 需要用户批准；' +
    '不能进入或退出由独立生命周期管理的 XForge。',
  executionMode: 'sequential',
  isConcurrencySafe: () => false,
  parameters: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['plan', 'default'],
        description: '目标模式。完成计划并准备实施时使用 default。'
      },
      reason: {
        type: 'string',
        description: '向用户说明切换原因和下一步动作。'
      }
    },
    required: ['mode', 'reason']
  },

  async execute(args, context) {
    const target = args.mode
    const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
    if (target !== 'plan' && target !== 'default') {
      return { success: false, output: '', error: 'mode 只能是 plan 或 default' }
    }
    if (!reason) {
      return { success: false, output: '', error: 'reason 不能为空' }
    }
    if (!context.switchMode) {
      return { success: false, output: '', error: '当前宿主不支持模式切换' }
    }

    try {
      const result = await context.switchMode(target, reason)
      if (result.previousMode === result.currentMode) {
        return { success: true, output: `当前已经是 ${result.currentMode} 模式。` }
      }
      return {
        success: true,
        output:
          `已从 ${result.previousMode} 切换到 ${result.currentMode} 模式。` +
          (result.currentMode === 'default'
            ? '当前任务将立即在 default 模式继续；实施前必须读取当前会话的 active plan。'
            : '当前任务将立即在 plan 模式继续，请分析仓库并保存完整计划。'),
        control: {
          type: 'mode_transition',
          previousMode: result.previousMode,
          currentMode: result.currentMode
        }
      }
    } catch (error) {
      return {
        success: false,
        output: '',
        error: `切换模式失败: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
}
