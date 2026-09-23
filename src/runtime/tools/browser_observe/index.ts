import type { ToolExecutor, ToolResult } from '../types'
import type { BrowserCommandContext, BrowserPort, BrowserToolDeps } from '../../browser'
import {
  failApplied,
  formatList,
  formatObservation,
  parseFail,
  requireBrowserPort,
  resolveBrowserCommandContext,
  unavailablePort
} from '../../browser'
import { browserNotApplied, parseBrowserObserveToolArgs } from '../../../shared/browser'

const DESCRIPTION = `browser_observe — 读取当前任务里的网页。只读，不滚动、不改焦点、不点击。

用法（用不到的字段不要传）：
- 读取页面快照：{"action":"snapshot","browserId":"<browserId>"}；只开了一个页面时可省略 browserId
- 列出已打开页面：{"action":"list"}

快照里 dom 行带 ref，并返回一行 observation。之后 browser_act / browser_capture 原样带上这行 observation 和 ref。
页面跳转、刷新或用户接管后旧 observation 立即失效，需要重新 snapshot。
iframe 内部内容不会进入快照，不要期待完整 HTML。`

type SnapshotTarget = { readonly ok: true; readonly browserId: string } | { readonly ok: false; readonly result: ToolResult }

/** 省略 browserId 时的推断：只有一个页面就读它；多个页面时读用户正在看的那页。 */
async function resolveSnapshotTarget(
  port: BrowserPort,
  context: BrowserCommandContext
): Promise<SnapshotTarget> {
  const listed = await port.listPages({ sessionId: context.sessionId }, context)
  if (listed.status !== 'applied') return { ok: false, result: failApplied(listed) }
  const { pages, activeBrowserId } = listed.snapshot
  if (pages.length === 0) {
    return {
      ok: false,
      result: failApplied(
        browserNotApplied(
          'invalid_request',
          '当前任务没有打开的页面，先用 browser_open {"action":"open","url":"https://…"} 打开'
        )
      )
    }
  }
  if (pages.length === 1) return { ok: true, browserId: pages[0].browserId }
  if (activeBrowserId && pages.some((page) => page.browserId === activeBrowserId)) {
    return { ok: true, browserId: activeBrowserId }
  }
  return {
    ok: false,
    result: failApplied(
      browserNotApplied(
        'invalid_request',
        `打开了多个页面，请指定 browserId：${pages.map((page) => page.browserId).join('、')}`
      )
    )
  }
}

export function createBrowserObserveTool(deps: BrowserToolDeps): ToolExecutor {
  return {
    name: 'browser_observe',
    description: DESCRIPTION,
    // 顶层保持扁平 object：多数服务商不支持顶层 oneOf，模型会看不到任何字段而乱猜。
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['snapshot', 'list'],
          description: 'snapshot=读取页面内容（默认）；list=列出已打开页面，不需要其它参数'
        },
        browserId: {
          type: 'string',
          description: 'snapshot 要读取的页面；只开了一个页面时可省略。list 不需要'
        }
      },
      required: ['action'],
      additionalProperties: false
    },
    executionMode: 'sequential',
    // 有意不声明 maxResultSizeChars：执行器会在归档机制看到全文之前硬截断，
    // 大快照走「先完整投递一轮、滑出窗口再归档」的既有通道。
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
      let browserId = parsed.value.browserId
      if (browserId === null) {
        const target = await resolveSnapshotTarget(port, resolved.value)
        if (!target.ok) return target.result
        browserId = target.browserId
      }
      const observed = await port.observe({ browserId }, resolved.value)
      if (observed.status !== 'applied') return failApplied(observed)
      return {
        success: true,
        output: formatObservation(observed.observation, observed.snapshot)
      }
    }
  }
}
