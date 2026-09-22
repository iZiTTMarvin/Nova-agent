import type { ToolExecutor, ToolResult } from '../types'
import type { BrowserToolDeps } from '../../browser'
import {
  buildAuthority,
  captureBudgetOwnerId,
  constrainBrowserCapture,
  failApplied,
  failUnknown,
  parseFail,
  probeProviderVision,
  requireBrowserPort,
  resolveBrowserCommandContext,
  tryConsumeCaptureBudget,
  unavailablePort
} from '../../browser'
import {
  browserNotApplied,
  parseBrowserCaptureToolArgs
} from '../../../shared/browser'
import type { ModelClient } from '../../model/ModelClient'

export interface BrowserCaptureToolDeps extends BrowserToolDeps {
  readonly saveEvidence?: (input: {
    readonly sessionId: string
    readonly mimeType: string
    readonly base64: string
  }) => Promise<string | null>
  readonly probeVision?: (
    modelClient: ModelClient | undefined,
    options?: { readonly abortSignal?: AbortSignal }
  ) => Promise<boolean>
}

const DESCRIPTION = `browser_capture — 捕获当前已设置好的视口截图。不滚动、不改视口。

必须带完整 observation。图片受预算约束：DPR=1、长边≤1440、≤2MP、单张≤1MiB、单轮≤6张。
当前模型不能消费图片时，返回文字说明和本地证据路径，不能把截图当作视觉验收已通过。
多模态图片不会被归档，只靠本轮预算控制。`

export function createBrowserCaptureTool(deps: BrowserCaptureToolDeps): ToolExecutor {
  const probe = deps.probeVision ?? probeProviderVision

  return {
    name: 'browser_capture',
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
        }
      },
      required: ['observation'],
      additionalProperties: false
    },
    executionMode: 'sequential',
    async execute(args, context): Promise<ToolResult> {
      const parsed = parseBrowserCaptureToolArgs(args)
      if (!parsed.ok) return parseFail(parsed.detail)
      const port = requireBrowserPort(deps.getPort)
      if (!port) return unavailablePort()
      const resolved = resolveBrowserCommandContext(context)
      if (!resolved.ok) return resolved.result

      const ownerId = captureBudgetOwnerId(
        buildAuthority(context, resolved.value.sessionId)?.resourceOwnerRunId ?? context.resourceOwnerRunId,
        context.runId
      )
      if (!ownerId) {
        return failApplied(browserNotApplied('invalid_request', '缺少 run 身份，无法计入截图预算'))
      }

      const captured = await port.capture(
        { observation: parsed.value.observation },
        resolved.value
      )
      if (captured.status === 'not_applied') return failApplied(captured)
      if (captured.status === 'outcome_unknown') return failUnknown(captured)

      const constrained = await constrainBrowserCapture(captured.image.base64)
      if (!constrained) {
        return failApplied(browserNotApplied('budget_exceeded', '截图无法压进单张预算（长边 1440 / 2MP / 1MiB）'))
      }

      const consumed = tryConsumeCaptureBudget(ownerId, constrained.bytes)
      if (!consumed.ok) {
        return failApplied(browserNotApplied('budget_exceeded', consumed.detail))
      }

      const evidencePath = deps.saveEvidence
        ? await deps.saveEvidence({
            sessionId: resolved.value.sessionId,
            mimeType: constrained.mimeType,
            base64: constrained.base64
          })
        : null

      const header = [
        `observationId: ${captured.observation.observationId}`,
        `browserId: ${captured.observation.browserId}`,
        `generation: ${captured.observation.generation}`,
        `documentEpoch: ${captured.observation.documentEpoch}`,
        `capturedAt: ${captured.capturedAt}`,
        `size: ${constrained.width}x${constrained.height}`,
        `bytes: ${constrained.bytes}`
      ]

      const canSendImage = await probe(context.modelClient, { abortSignal: context.abortSignal })

      if (!canSendImage) {
        return {
          success: true,
          output: [
            ...header,
            `status: text_only`,
            '当前服务商未能接受图片（真实探测失败，不能只凭模型名判断）。视觉验收需换可看图的模型。',
            evidencePath ? `localEvidence: ${evidencePath}` : 'localEvidence: (not saved)'
          ].join('\n')
        }
      }

      return {
        success: true,
        output: [
          ...header,
          `status: image`,
          evidencePath ? `localEvidence: ${evidencePath}` : ''
        ]
          .filter((line) => line.length > 0)
          .join('\n'),
        images: [{ data: constrained.base64, mimeType: constrained.mimeType }]
      }
    }
  }
}
