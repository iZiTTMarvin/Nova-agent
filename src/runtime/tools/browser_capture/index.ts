import { assertSideEffectAllowed } from '../types'
import type { ToolExecutor, ToolResult } from '../types'
import type { BrowserToolDeps } from '../../browser'
import {
  buildAuthority,
  captureBudgetOwnerId,
  constrainBrowserCapture,
  failApplied,
  failUnknown,
  observationParameterSchema,
  parseFail,
  probeProviderVision,
  requireBrowserPort,
  resolveBrowserCommandContext,
  tryConsumeCaptureBudget,
  unavailablePort
} from '../../browser'
import {
  browserNotApplied,
  formatBrowserViewport,
  parseBrowserCaptureToolArgs
} from '../../../shared/browser'
import type { ModelClient } from '../../model/ModelClient'

export interface BrowserCaptureToolDeps extends BrowserToolDeps {
  readonly saveEvidence?: (input: {
    readonly sessionId: string
    readonly mimeType: string
    readonly base64: string
  }) => Promise<Extract<import('../../../shared/evidence').EvidenceReference, { kind: 'image' }> | null>
  readonly probeVision?: (
    modelClient: ModelClient | undefined,
    options?: { readonly abortSignal?: AbortSignal }
  ) => Promise<boolean>
}

const DESCRIPTION = `browser_capture — capture a screenshot of the currently set-up viewport. No scrolling, no viewport changes.

Parameters: {"observation":{"browserId":"brw_…","generation":1,"documentEpoch":1,"observationId":"obs_…"}}; copy the observation line returned by the most recent browser_observe snapshot verbatim.
Images are budget-constrained: DPR=1, long edge ≤1440, ≤2MP, ≤1MiB per image, ≤6 per turn.
When the current model cannot consume images, the tool returns a text explanation plus a saved evidence reference — a screenshot must not be treated as passed visual acceptance.
Saved evidence references can be selected with present_evidence. Saving failure does not imply visual acceptance.`

export function createBrowserCaptureTool(deps: BrowserCaptureToolDeps): ToolExecutor {
  const probe = deps.probeVision ?? probeProviderVision

  return {
    name: 'browser_capture',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        observation: observationParameterSchema()
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

      assertSideEffectAllowed(context, '保存截图证据')
      const saved = deps.saveEvidence
        ? await deps.saveEvidence({
            sessionId: resolved.value.sessionId,
            mimeType: constrained.mimeType,
            base64: constrained.base64
          })
        : null

      assertSideEffectAllowed(context, '返回截图证据')
      const pages = await port.listPages({ sessionId: resolved.value.sessionId }, resolved.value)
      const page = pages.status === 'applied' ? pages.snapshot.pages.find(page =>
        page.sessionId === resolved.value.sessionId && page.browserId === captured.observation.browserId &&
        page.generation === captured.observation.generation && page.documentEpoch === captured.observation.documentEpoch) : undefined
      const evidence = saved ? [{ ...saved, ...(page ? { browser: {
        browserId: page.browserId, generation: page.generation, documentEpoch: page.documentEpoch, url: page.url
      } } : {}) }] : undefined
      const savedNotice = saved ? `imageEvidence: ${saved.url}` : 'imageEvidence: (not saved; no persistent screenshot available)'

      const header = [
        `observationId: ${captured.observation.observationId}`,
        `browserId: ${captured.observation.browserId}`,
        `generation: ${captured.observation.generation}`,
        `documentEpoch: ${captured.observation.documentEpoch}`,
        `capturedAt: ${captured.capturedAt}`,
        `size: ${constrained.width}x${constrained.height}`,
        `bytes: ${constrained.bytes}`,
        `viewport: ${formatBrowserViewport(captured.viewport)}`
      ]

      const canSendImage = await probe(context.modelClient, { abortSignal: context.abortSignal })
      assertSideEffectAllowed(context, '返回截图证据')

      if (!canSendImage) {
        return {
          success: true,
          output: [
            ...header,
            `status: text_only`,
            '当前服务商未能接受图片（真实探测失败，不能只凭模型名判断）。视觉验收需换可看图的模型。',
            savedNotice
          ].join('\n'),
          ...(evidence ? { evidence } : {})
        }
      }

      return {
        success: true,
        output: [
          ...header,
          `status: image`,
          savedNotice
        ]
          .filter((line) => line.length > 0)
          .join('\n'),
        ...(evidence ? { evidence } : {}),
        images: [{ data: constrained.base64, mimeType: constrained.mimeType }]
      }
    }
  }
}
