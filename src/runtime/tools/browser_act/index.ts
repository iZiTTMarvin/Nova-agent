import type { ToolExecutor, ToolResult } from '../types'
import type { BrowserToolDeps } from '../../browser'
import {
  failApplied,
  failUnknown,
  formatObservationArg,
  observationParameterSchema,
  parseFail,
  requireBrowserPort,
  resolveBrowserCommandContext,
  unavailablePort
} from '../../browser'
import { parseBrowserActToolArgs } from '../../../shared/browser'

const DESCRIPTION = `browser_act — perform one click, fill, or similar operation on the page from the most recent browser_observe snapshot.

Parameters: copy the snapshot's observation line into observation verbatim; fill only the fields each action kind needs:
- Click: {"kind":"click","ref":"e3"}
- Fill: {"kind":"fill","ref":"e3","text":"content"}
- Select: {"kind":"select","ref":"e3","values":["option"]}
- Key press: {"kind":"press","ref":"e3","key":"Enter"}
- Scroll: {"kind":"scroll","direction":"down","amount":"page"} (amount may be page / half-page)
- Viewport: {"kind":"viewport","width":390,"height":844,"device":"mobile"}

Full example: {"observation":{"browserId":"brw_…","generation":1,"documentEpoch":1,"observationId":"obs_…"},"action":{"kind":"click","ref":"e3"}}

ref comes from the snapshot dom lines. Before acting, the tool re-confirms the target is still present, unique, and unobscured; after a navigation or an obvious content change, snapshot again before continuing.
When outcome_unknown is returned, do not replay the action — observe again first.
An applied action does not mean a copy, download, or save succeeded; such effects must be confirmed separately through permission notices and checkable business results.`

export function createBrowserActTool(deps: BrowserToolDeps): ToolExecutor {
  return {
    name: 'browser_act',
    description: DESCRIPTION,
    // action 用单个扁平 object + kind 枚举，而不是 oneOf：部分服务商不支持组合 schema。
    // 各 kind 需要哪些字段由描述和入参解析负责。
    parameters: {
      type: 'object',
      properties: {
        observation: observationParameterSchema(),
        action: {
          type: 'object',
          description: 'The operation to perform; fill only the fields the current kind needs',
          properties: {
            kind: {
              type: 'string',
              enum: ['click', 'fill', 'select', 'press', 'scroll', 'viewport']
            },
            ref: { type: 'string', description: 'click / fill / select / press: the ref from the snapshot dom lines' },
            text: { type: 'string', description: 'fill: the text to type in' },
            values: {
              type: 'array',
              items: { type: 'string' },
              description: 'select: the option values or labels to select'
            },
            key: { type: 'string', description: 'press: the key name, e.g. Enter, Tab, Escape' },
            direction: { type: 'string', enum: ['up', 'down'], description: 'scroll: direction' },
            amount: { type: 'string', enum: ['page', 'half-page'], description: 'scroll: amount; defaults to page' },
            width: { type: 'integer', minimum: 1, maximum: 4096, description: 'viewport: width' },
            height: { type: 'integer', minimum: 1, maximum: 4096, description: 'viewport: height' },
            device: { type: 'string', enum: ['desktop', 'mobile'], description: 'viewport: device type' }
          },
          required: ['kind'],
          additionalProperties: false
        }
      },
      required: ['observation', 'action'],
      additionalProperties: false
    },
    executionMode: 'sequential',
    async execute(args, context): Promise<ToolResult> {
      const parsed = parseBrowserActToolArgs(args)
      if (!parsed.ok) return parseFail(parsed.detail)
      const port = requireBrowserPort(deps.getPort)
      if (!port) return unavailablePort()
      const resolved = resolveBrowserCommandContext(context)
      if (!resolved.ok) return resolved.result
      const result = await port.act(parsed.value, resolved.value)
      if (result.status === 'not_applied') return failApplied(result)
      if (result.status === 'outcome_unknown') return failUnknown(result)
      return {
        success: true,
        output: [
          `status: applied`,
          `summary: ${result.summary}`,
          `observationId: ${result.observation.observationId}`,
          `browserId: ${result.observation.browserId}`,
          `generation: ${result.observation.generation}`,
          `documentEpoch: ${result.observation.documentEpoch}`,
          `observation: ${formatObservationArg(result.observation)}`,
          '（页面没跳转可继续用这行 observation；要确认结果先重新 snapshot）'
        ].join('\n')
      }
    }
  }
}
