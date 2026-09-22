import { afterEach, describe, expect, it, vi } from 'vitest'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import { createBrowserOpenTool } from '../../../../src/runtime/tools/browser_open'
import { createBrowserObserveTool } from '../../../../src/runtime/tools/browser_observe'
import { createBrowserActTool } from '../../../../src/runtime/tools/browser_act'
import { createBrowserCloseTool } from '../../../../src/runtime/tools/browser_close'
import { createBrowserCaptureTool } from '../../../../src/runtime/tools/browser_capture'
import { resetCaptureBudgetForTests } from '../../../../src/runtime/browser/captureBudget'
import {
  browserNotApplied,
  type ActionOutcome,
  type BrowserCaptureResult,
  type BrowserObserveResult,
  type ObservationIdentity
} from '../../../../src/shared/browser'
import type { BrowserPort } from '../../../../src/runtime/browser'
import type { ToolContext } from '../../../../src/runtime/tools/types'
import type { ModelClient } from '../../../../src/runtime/model/ModelClient'

const observation: ObservationIdentity = {
  browserId: 'brw_1',
  generation: 1,
  documentEpoch: 1,
  observationId: 'obs_1'
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: process.cwd(),
    readState: createReadState(),
    sessionId: 'sess_1',
    runId: 'run_1',
    resourceOwnerRunId: 'run_1',
    invocationRef: {
      sessionId: 'sess_1',
      runId: 'run_1',
      messageId: 'msg_1',
      toolCallId: 'call_1'
    },
    supportsVision: true,
    ...overrides
  }
}

function fakePort(overrides: Partial<BrowserPort> = {}): BrowserPort {
  return {
    open: vi.fn(async () => browserNotApplied('unavailable', 'open unused')),
    navigate: vi.fn(async () => browserNotApplied('unavailable', 'navigate unused')),
    observe: vi.fn(async () => browserNotApplied('unavailable', 'observe unused')),
    act: vi.fn(async () => browserNotApplied('unavailable', 'act unused')),
    capture: vi.fn(async () => browserNotApplied('unavailable', 'capture unused')),
    close: vi.fn(async () => browserNotApplied('unavailable', 'close unused')),
    listPages: vi.fn(async () => browserNotApplied('unavailable', 'list unused')),
    claim: vi.fn(async () => browserNotApplied('unavailable', 'claim unused')),
    release: vi.fn(async () => browserNotApplied('unavailable', 'release unused')),
    ...overrides
  }
}

afterEach(() => {
  resetCaptureBudgetForTests()
})

describe('browser 工具契约', () => {
  it('五个工具都是 sequential，schema 用判别联合', () => {
    const port = fakePort()
    const tools = [
      createBrowserOpenTool({ getPort: () => port }),
      createBrowserObserveTool({ getPort: () => port }),
      createBrowserActTool({ getPort: () => port }),
      createBrowserCloseTool({ getPort: () => port }),
      createBrowserCaptureTool({ getPort: () => port })
    ]
    for (const tool of tools) {
      expect(tool.executionMode).toBe('sequential')
    }
    expect(createBrowserOpenTool({ getPort: () => port }).parameters).toHaveProperty('oneOf')
    expect(createBrowserObserveTool({ getPort: () => port }).parameters).toHaveProperty('oneOf')
    const actAction = (
      createBrowserActTool({ getPort: () => port }).parameters as {
        properties: { action: { oneOf: unknown[] } }
      }
    ).properties.action
    expect(actAction.oneOf.length).toBe(6)
  })

  it('observationId 未通过契约校验时不呼叫 Host', async () => {
    const port = fakePort()
    const act = createBrowserActTool({ getPort: () => port })
    const result = await act.execute(
      { action: { kind: 'click', ref: 'e1' } },
      context()
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('invalid_request')
    expect(port.act).not.toHaveBeenCalled()
  })

  it('动作前重校验错误码原样返回，outcome_unknown 不自动重放', async () => {
    const actCalls: unknown[] = []
    const port = fakePort({
      act: vi.fn(async (command) => {
        actCalls.push(command)
        if (actCalls.length === 1) {
          return browserNotApplied('target_occluded', '目标被挡住')
        }
        return { status: 'outcome_unknown', detail: '点击已发出但无法确认' } satisfies ActionOutcome
      })
    })
    const act = createBrowserActTool({ getPort: () => port })
    const missing = await act.execute(
      { observation, action: { kind: 'click', ref: 'e1' } },
      context()
    )
    expect(missing.error).toBe('[target_occluded] 目标被挡住')
    expect(port.act).toHaveBeenCalledTimes(1)

    const unknown = await act.execute(
      { observation, action: { kind: 'click', ref: 'e1' } },
      context()
    )
    expect(unknown.success).toBe(false)
    expect(unknown.error).toContain('outcome_unknown')
    expect(unknown.error).toContain('不要重放')
    expect(port.act).toHaveBeenCalledTimes(2)
  })

  it('observe 列出页面并格式化快照', async () => {
    const port = fakePort({
      observe: vi.fn(async (): Promise<BrowserObserveResult> => ({
        status: 'applied',
        observation,
        snapshot: {
          url: 'https://example.com',
          title: 'Example',
          viewport: { width: 800, height: 600, device: 'desktop' },
          dom: '- button [ref=e1]: 保存',
          elements: [
            {
              ref: 'e1',
              role: 'button',
              name: '保存',
              selector: 'button',
              rect: { x: 1, y: 2, width: 3, height: 4 }
            }
          ],
          truncated: false,
          limits: ['subframes']
        }
      }))
    })
    const observe = createBrowserObserveTool({ getPort: () => port })
    const result = await observe.execute({ action: 'snapshot', browserId: 'brw_1' }, context())
    expect(result.success).toBe(true)
    expect(result.output).toContain('observationId: obs_1')
    expect(result.output).toContain('limits: subframes')
    expect(result.output).toContain('- e1  button  保存')
  })

  it('截图发图前做真实探测，关键字为 false 也不当作可用', async () => {
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const port = fakePort({
      capture: vi.fn(async (): Promise<BrowserCaptureResult> => ({
        status: 'applied',
        observation,
        width: 1,
        height: 1,
        capturedAt: 1,
        image: { mimeType: 'image/png', base64: png }
      }))
    })
    const capture = createBrowserCaptureTool({
      getPort: () => port,
      probeVision: async () => false,
      saveEvidence: async () => 'D:\\\\captures\\\\shot.png'
    })
    const result = await capture.execute({ observation }, context({ supportsVision: false }))
    expect(result.success).toBe(true)
    expect(result.images).toBeUndefined()
    expect(result.output).toContain('text_only')
    expect(result.output).toContain('真实探测失败')
    expect(result.output).toContain('D:\\\\captures\\\\shot.png')
  })

  it('截图 run 预算在第六张之后耗尽', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    ).toString('base64')
    const port = fakePort({
      capture: vi.fn(async (): Promise<BrowserCaptureResult> => ({
        status: 'applied',
        observation,
        width: 1,
        height: 1,
        capturedAt: 1,
        image: { mimeType: 'image/png', base64: png }
      }))
    })
    const capture = createBrowserCaptureTool({
      getPort: () => port,
      probeVision: async () => true
    })
    const modelClient = {
      chat: async function* () {
        yield { type: 'text_delta', delta: 'ok' }
      },
      updateConfig() {}
    } as unknown as ModelClient
    for (let i = 0; i < 6; i++) {
      const result = await capture.execute({ observation }, context({ modelClient }))
      expect(result.success).toBe(true)
    }
    const overflow = await capture.execute({ observation }, context({ modelClient }))
    expect(overflow.success).toBe(false)
    expect(overflow.error).toContain('budget_exceeded')
  })
})
