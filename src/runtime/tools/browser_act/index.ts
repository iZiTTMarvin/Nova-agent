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
import { parseBrowserActCommand } from '../../../shared/browser'

const DESCRIPTION = `browser_act — 对最近一次观察中的目标执行一次写入动作。

必须带完整 observation（browserId、generation、documentEpoch、observationId）以及互斥 action：
- click / fill / select / press：需要 ref
- scroll：direction + amount
- viewport：width、height、device

动作前会重校验目标是否仍在、唯一、未被遮挡。失败码包括 target_missing、target_ambiguous、target_occluded、stale_observation、taken_over。
若返回 outcome_unknown，不要重放该动作，先重新观察。`

export function createBrowserActTool(deps: BrowserToolDeps): ToolExecutor {
  return {
    name: 'browser_act',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        observation: {
          type: 'object',
          properties: {
            browserId: { type: 'string' },
            generation: { type: 'integer', minimum: 1 },
            documentEpoch: { type: 'integer', minimum: 1 },
            observationId: { type: 'string' }
          },
          required: ['browserId', 'generation', 'documentEpoch', 'observationId'],
          additionalProperties: false
        },
        action: {
          oneOf: [
            {
              type: 'object',
              properties: {
                kind: { type: 'string', const: 'click' },
                ref: { type: 'string' }
              },
              required: ['kind', 'ref'],
              additionalProperties: false
            },
            {
              type: 'object',
              properties: {
                kind: { type: 'string', const: 'fill' },
                ref: { type: 'string' },
                text: { type: 'string' }
              },
              required: ['kind', 'ref', 'text'],
              additionalProperties: false
            },
            {
              type: 'object',
              properties: {
                kind: { type: 'string', const: 'select' },
                ref: { type: 'string' },
                values: { type: 'array', items: { type: 'string' }, minItems: 1 }
              },
              required: ['kind', 'ref', 'values'],
              additionalProperties: false
            },
            {
              type: 'object',
              properties: {
                kind: { type: 'string', const: 'press' },
                ref: { type: 'string' },
                key: { type: 'string' }
              },
              required: ['kind', 'ref', 'key'],
              additionalProperties: false
            },
            {
              type: 'object',
              properties: {
                kind: { type: 'string', const: 'scroll' },
                direction: { type: 'string', enum: ['up', 'down'] },
                amount: { type: 'string', enum: ['page', 'half-page'] }
              },
              required: ['kind', 'direction', 'amount'],
              additionalProperties: false
            },
            {
              type: 'object',
              properties: {
                kind: { type: 'string', const: 'viewport' },
                width: { type: 'integer', minimum: 1, maximum: 4096 },
                height: { type: 'integer', minimum: 1, maximum: 4096 },
                device: { type: 'string', enum: ['desktop', 'mobile'] }
              },
              required: ['kind', 'width', 'height', 'device'],
              additionalProperties: false
            }
          ]
        }
      },
      required: ['observation', 'action'],
      additionalProperties: false
    },
    executionMode: 'sequential',
    async execute(args, context): Promise<ToolResult> {
      const parsed = parseBrowserActCommand(args)
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
          `documentEpoch: ${result.observation.documentEpoch}`
        ].join('\n')
      }
    }
  }
}
