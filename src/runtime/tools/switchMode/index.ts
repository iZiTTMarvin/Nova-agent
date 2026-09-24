import type { ToolExecutor } from '../types'

export const switchModeTool: ToolExecutor = {
  name: 'switch_mode',
  description:
    'Switch between plan and default modes within the same session. ' +
    'Entering plan continues planning immediately in the current task; returning from plan to default requires user approval; ' +
    'XForge, governed by an independent lifecycle, cannot be entered or exited here.',
  executionMode: 'sequential',
  isConcurrencySafe: () => false,
  parameters: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['plan', 'default'],
        description: 'Target mode. Use default when the user has explicitly approved the plan and is ready to implement.'
      },
      reason: {
        type: 'string',
        description: 'Explain to the user why you are switching and what happens next.'
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
