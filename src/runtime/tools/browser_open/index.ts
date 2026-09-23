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

const DESCRIPTION = `browser_open — 在 Nova 内置浏览器里打开网页或控制已有页面的导航。

用法（按需填写字段，用不到的字段不要传）：
- 新建页面：{"action":"open","url":"https://example.com"}
- 在已有页面跳转：{"action":"open","browserId":"<browserId>","url":"https://example.com/next"}
- 后退 / 前进 / 刷新 / 停止：{"action":"back","browserId":"<browserId>"}，action 换成 forward / reload / stop

browserId 来自本工具或 browser_observe list 的返回。已有页面时优先在原页面跳转，不要反复新建（最多同时 2 个页面）。
只接受不含账号密码的 http(s) 地址。点击、填写等页面内操作用 browser_act。`

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
          description: 'open=打开网址（带 browserId 时在该页跳转）；back/forward/reload/stop=控制已有页面'
        },
        url: { type: 'string', description: 'action=open 时必填，http(s) 地址' },
        browserId: {
          type: 'string',
          description: 'back/forward/reload/stop 必填；open 时可选，填写则在该页面跳转而不新建页面'
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
