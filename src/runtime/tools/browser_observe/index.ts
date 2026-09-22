import type { ToolExecutor, ToolResult } from '../types'
import type { BrowserToolDeps } from '../../browser'
import {
  failApplied,
  formatList,
  formatObservation,
  parseFail,
  requireBrowserPort,
  resolveBrowserCommandContext,
  unavailablePort
} from '../../browser'
import { parseBrowserObserveToolArgs } from '../../../shared/browser'

const DESCRIPTION = `browser_observe — 读取当前任务里的网页。只读，不滚动、不改焦点、不点击。

参数是判别联合：
- list：列出已打开页面
- snapshot + browserId：返回有界语义快照（dom 行带 ref，elements 含 selector/rect）

后续点击/填写必须使用本次返回的 observationId。页面导航或用户接管后旧观察立即失效。
iframe 内部内容不会进入快照。不要声明或期待完整 HTML。`

export function createBrowserObserveTool(deps: BrowserToolDeps): ToolExecutor {
  return {
    name: 'browser_observe',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      oneOf: [
        {
          type: 'object',
          properties: {
            action: { type: 'string', const: 'list', description: '列出当前任务打开的页面' }
          },
          required: ['action'],
          additionalProperties: false
        },
        {
          type: 'object',
          properties: {
            action: { type: 'string', const: 'snapshot', description: '读取指定页面快照' },
            browserId: { type: 'string' }
          },
          required: ['action', 'browserId'],
          additionalProperties: false
        }
      ]
    },
    executionMode: 'sequential',
    async execute(args, context): Promise<ToolResult> {
      const parsed = parseBrowserObserveToolArgs(args)
      if (!parsed.ok) return parseFail(parsed.detail)
      const port = requireBrowserPort(deps.getPort)
      if (!port) return unavailablePort()
      const resolved = resolveBrowserCommandContext(context)
      if (!resolved.ok) return resolved.result
      if (parsed.value.action === 'list') {
        const listed = await port.listPages(
          { sessionId: resolved.value.sessionId },
          resolved.value
        )
        if (listed.status !== 'applied') return failApplied(listed)
        return { success: true, output: formatList(listed.snapshot) }
      }
      const observed = await port.observe({ browserId: parsed.value.browserId }, resolved.value)
      if (observed.status !== 'applied') return failApplied(observed)
      return {
        success: true,
        output: formatObservation(observed.observation, observed.snapshot)
      }
    }
  }
}
