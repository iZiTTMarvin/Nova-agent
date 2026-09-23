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

const DESCRIPTION = `browser_act — 在最近一次 browser_observe snapshot 的页面上执行一次点击、填写等操作。

参数：observation 原样复制快照返回的 observation 行；action 按 kind 只填需要的字段：
- 点击：{"kind":"click","ref":"e3"}
- 填写：{"kind":"fill","ref":"e3","text":"内容"}
- 下拉选择：{"kind":"select","ref":"e3","values":["选项"]}
- 按键：{"kind":"press","ref":"e3","key":"Enter"}
- 滚动：{"kind":"scroll","direction":"down","amount":"page"}（amount 可为 page / half-page）
- 视口：{"kind":"viewport","width":390,"height":844,"device":"mobile"}

完整示例：{"observation":{"browserId":"brw_…","generation":1,"documentEpoch":1,"observationId":"obs_…"},"action":{"kind":"click","ref":"e3"}}

ref 取自快照 dom 行。操作前会重新确认目标仍在、唯一、未被遮挡；页面跳转或内容明显变化后，先重新 snapshot 再继续。
返回 outcome_unknown 时不要重放该动作，先重新观察。
动作已应用不等于复制、下载或保存成功；此类效果需根据权限通知与可核对的业务结果另行确认。`

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
          description: '要执行的操作，只填当前 kind 需要的字段',
          properties: {
            kind: {
              type: 'string',
              enum: ['click', 'fill', 'select', 'press', 'scroll', 'viewport']
            },
            ref: { type: 'string', description: 'click / fill / select / press：快照 dom 行里的 ref' },
            text: { type: 'string', description: 'fill：要填入的文字' },
            values: {
              type: 'array',
              items: { type: 'string' },
              description: 'select：要选中的选项值或文字'
            },
            key: { type: 'string', description: 'press：按键名，如 Enter、Tab、Escape' },
            direction: { type: 'string', enum: ['up', 'down'], description: 'scroll：方向' },
            amount: { type: 'string', enum: ['page', 'half-page'], description: 'scroll：幅度，默认 page' },
            width: { type: 'integer', minimum: 1, maximum: 4096, description: 'viewport：宽度' },
            height: { type: 'integer', minimum: 1, maximum: 4096, description: 'viewport：高度' },
            device: { type: 'string', enum: ['desktop', 'mobile'], description: 'viewport：设备类型' }
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
