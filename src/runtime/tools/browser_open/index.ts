import type { ToolExecutor, ToolResult } from '../types'
import type { BrowserToolDeps } from '../../browser/toolSupport'
import {
  failApplied,
  failUnknown,
  formatPage,
  parseFail,
  requireBrowserPort,
  resolveBrowserCommandContext,
  unavailablePort
} from '../../browser/toolSupport'
import { parseBrowserOpenToolArgs } from '../../../shared/browser'

const DESCRIPTION = `browser_open — 在 Nova 内打开或导航网页。创建页面、前进、后退、刷新、停止都走这一工具。

参数是判别联合，只能选一种 action：
- open + url：新建页面
- url + browserId + url：在已有页面跳转
- back / forward / reload / stop + browserId：导航控制

只接受不含用户信息的 http(s) 地址。不要用它执行点击或填写。`

export function createBrowserOpenTool(deps: BrowserToolDeps): ToolExecutor {
  return {
    name: 'browser_open',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      oneOf: [
        {
          type: 'object',
          properties: {
            action: { type: 'string', const: 'open', description: '新建页面' },
            url: { type: 'string', description: 'http 或 https 地址' }
          },
          required: ['action', 'url'],
          additionalProperties: false
        },
        {
          type: 'object',
          properties: {
            action: { type: 'string', const: 'url', description: '已有页面跳转' },
            browserId: { type: 'string' },
            url: { type: 'string', description: 'http 或 https 地址' }
          },
          required: ['action', 'browserId', 'url'],
          additionalProperties: false
        },
        {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['back', 'forward', 'reload', 'stop'] },
            browserId: { type: 'string' }
          },
          required: ['action', 'browserId'],
          additionalProperties: false
        }
      ]
    },
    executionMode: 'sequential',
    async execute(args, context): Promise<ToolResult> {
      const parsed = parseBrowserOpenToolArgs(args)
      if (!parsed.ok) return parseFail(parsed.detail)
      const port = requireBrowserPort(deps.getPort)
      if (!port) return unavailablePort()
      const resolved = resolveBrowserCommandContext(context)
      if (!resolved.ok) return resolved.result
      const result =
        parsed.value.action === 'open'
          ? await port.open({ url: parsed.value.url }, resolved.value)
          : await port.navigate(
              {
                browserId: parsed.value.browserId,
                action:
                  parsed.value.action === 'url'
                    ? { kind: 'url', url: parsed.value.url }
                    : { kind: parsed.value.action }
              },
              resolved.value
            )
      if (result.status === 'not_applied') return failApplied(result)
      if (result.status === 'outcome_unknown') return failUnknown(result)
      return { success: true, output: formatPage(result.page) }
    }
  }
}
