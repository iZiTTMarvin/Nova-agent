import type { ToolExecutor, ToolResult } from '../types'
import type { BrowserToolDeps } from '../../browser'
import {
  failApplied,
  failUnknown,
  formatPage,
  parseFail,
  requireBrowserPort,
  resolveBrowserCommandContext,
  unavailablePort
} from '../../browser'
import { parseBrowserOpenToolArgs } from '../../../shared/browser'

const DESCRIPTION = `browser_open — open a web page in Nova's built-in browser, or navigate an already-open page.

Usage (fill only the fields you need; omit unused ones):
- Open a new page: {"action":"open","url":"https://example.com"}
- Navigate an existing page: {"action":"open","browserId":"<browserId>","url":"https://example.com/next"}
- Back / forward / reload / stop: {"action":"back","browserId":"<browserId>"}, with action swapped to forward / reload / stop

browserId comes from this tool's return or from browser_observe list. When a page is already open, prefer navigating it in place rather than repeatedly creating new ones (at most 2 pages at once).
Only http(s) addresses without embedded credentials are accepted. For in-page operations such as clicking and filling, use browser_act.`

export function createBrowserOpenTool(deps: BrowserToolDeps): ToolExecutor {
  return {
    name: 'browser_open',
    description: DESCRIPTION,
    // 顶层保持扁平 object：多数服务商不支持顶层 oneOf，模型会看不到任何字段而乱猜。
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'back', 'forward', 'reload', 'stop'],
          description: 'open=open a URL (navigates within that page when browserId is given); back/forward/reload/stop=control an existing page'
        },
        url: { type: 'string', description: 'Required when action=open; an http(s) address' },
        browserId: {
          type: 'string',
          description: 'Required for back/forward/reload/stop; optional for open, in which case it navigates that page instead of creating a new one'
        }
      },
      required: ['action'],
      additionalProperties: false
    },
    executionMode: 'sequential',
    async execute(args, context): Promise<ToolResult> {
      const parsed = parseBrowserOpenToolArgs(args)
      if (!parsed.ok) return parseFail(parsed.detail)
      const port = requireBrowserPort(deps.getPort)
      if (!port) return unavailablePort()
      const resolved = resolveBrowserCommandContext(context)
      if (!resolved.ok) return resolved.result
      const request = parsed.value
      const result =
        request.action === 'open'
          ? await port.open({ url: request.url }, resolved.value)
          : await port.navigate(
              {
                browserId: request.browserId,
                action:
                  request.action === 'navigate'
                    ? { kind: 'url', url: request.url }
                    : { kind: request.action }
              },
              resolved.value
            )
      if (result.status === 'not_applied') return failApplied(result)
      if (result.status === 'outcome_unknown') return failUnknown(result)
      return {
        success: true,
        output: [
          formatPage(result.page),
          '',
          `下一步：browser_observe {"action":"snapshot","browserId":"${result.page.browserId}"} 读取页面内容`
        ].join('\n')
      }
    }
  }
}
