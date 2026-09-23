import type { ToolExecutor, ToolResult } from '../types'
import type { BrowserToolDeps } from '../../browser'
import {
  failApplied,
  failUnknown,
  parseFail,
  requireBrowserPort,
  resolveBrowserCommandContext,
  unavailablePort
} from '../../browser'
import { parseBrowserCloseToolArgs } from '../../../shared/browser'

const DESCRIPTION = `browser_close — 关闭指定内置网页。未提交的表单状态可能丢失。

参数：{"browserId":"<browserId>"}，browserId 见 browser_open 或 browser_observe list 的返回。`

export function createBrowserCloseTool(deps: BrowserToolDeps): ToolExecutor {
  return {
    name: 'browser_close',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        browserId: { type: 'string', description: '要关闭的页面' }
      },
      required: ['browserId'],
      additionalProperties: false
    },
    executionMode: 'sequential',
    async execute(args, context): Promise<ToolResult> {
      const parsed = parseBrowserCloseToolArgs(args)
      if (!parsed.ok) return parseFail(parsed.detail)
      const port = requireBrowserPort(deps.getPort)
      if (!port) return unavailablePort()
      const resolved = resolveBrowserCommandContext(context)
      if (!resolved.ok) return resolved.result
      const result = await port.close({ browserId: parsed.value.browserId }, resolved.value)
      if (result.status === 'not_applied') return failApplied(result)
      if (result.status === 'outcome_unknown') return failUnknown(result)
      return { success: true, output: `已关闭页面 ${result.browserId}` }
    }
  }
}
