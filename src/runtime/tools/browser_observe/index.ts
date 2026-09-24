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

const DESCRIPTION = `browser_observe — read web pages of the current task. Read-only: no scrolling, no focus changes, no clicking.

Usage (omit unused fields):
- Read a page snapshot: {"action":"snapshot","browserId":"<browserId>"}; browserId may be omitted when only one page is open
- Focus a named region: {"action":"snapshot","focus":{"role":"region","name":"Production Status"}}; returns a focused observation only when the target is unique and the result complete
- List open pages: {"action":"list"}

Snapshot dom lines carry refs, and one observation line is returned. Pass that observation line and the refs to browser_act / browser_capture unchanged.
An observation goes stale immediately after a page navigation, refresh, or user takeover — snapshot again.
Content inside iframes does not enter the snapshot; do not expect complete HTML.`

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
          description: 'snapshot=read page content (default); list=list open pages, needs no other parameters'
        },
        browserId: {
          type: 'string',
          description: 'The page to snapshot; may be omitted when only one page is open. Not needed for list.'
        },
        focus: {
          type: 'object',
          description: 'Optional: focus the observation by accessible role and exact name; falls back to the whole page when the target is not unique or complete',
          properties: {
            role: { type: 'string', maxLength: 60 },
            name: { type: 'string', maxLength: 120 }
          },
          required: ['role', 'name'],
          additionalProperties: false
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
      const observed = await port.observe({ browserId, ...(parsed.value.focus ? { focus: parsed.value.focus } : {}) }, resolved.value)
      if (observed.status !== 'applied') return failApplied(observed)
      return {
        success: true,
        output: formatObservation(observed.observation, observed.snapshot, observed.notice)
      }
    }
  }
}
