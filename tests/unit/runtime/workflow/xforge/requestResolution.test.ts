import {
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelClient } from '../../../../../src/runtime/model/ModelClient'
import type { ChatEvent } from '../../../../../src/runtime/model/types'
import type { XForgeMainAgentSession } from '../../../../../src/runtime/workflow/xforge/mainAgentSession'
import {
  classifyXForgeRequest,
  extractReferencedMarkdownPath,
  importReferencedValidatedPlan,
  looksLikeImportablePlan,
  resolveXForgeRequestSignals
} from '../../../../../src/runtime/workflow/xforge/requestResolution'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scriptedClient(outputs: Array<string | ChatEvent[]>): ModelClient {
  let index = 0
  return {
    async *chat(): AsyncIterable<ChatEvent> {
      const output = outputs[index++]
      if (output === undefined) throw new Error(`unexpected model call ${index}`)
      if (Array.isArray(output)) {
        for (const event of output) yield event
        return
      }
      yield { type: 'text_delta', delta: output }
      yield { type: 'message_end', finishReason: 'stop' }
    },
    updateConfig() {}
  }
}

describe('requestResolution', () => {
  it('确定性分类覆盖 reviewOnly / codeReady / bugfix / full-dev', () => {
    expect(classifyXForgeRequest('只审查，不要改代码').reviewOnly).toBe(true)
    expect(classifyXForgeRequest('代码已经改好，只帮我测试').codeReadyForTest).toBe(true)
    expect(classifyXForgeRequest('这个页面加载好卡').isBugfix).toBe(true)
    expect(classifyXForgeRequest('/br-full-dev 实现登录', true).requestedStartStage).toBe('brainstorm')
  })

  it('解析 Windows 分隔符、引号、空格与中文路径', () => {
    expect(extractReferencedMarkdownPath('看 `docs\\计划 草案.md`')).toBe('docs\\计划 草案.md')
    expect(extractReferencedMarkdownPath('参考 "docs/方案.md"')).toBe('docs/方案.md')
    expect(extractReferencedMarkdownPath("打开 '设计/范围.md'")).toBe('设计/范围.md')
    expect(extractReferencedMarkdownPath('请读 `docs/中文路径.md` 并继续')).toBe('docs/中文路径.md')
  })

  it('looksLikeImportablePlan 拒绝缺少验收/范围/风险的文档', () => {
    expect(looksLikeImportablePlan('# 随便\n- [ ] 任务一\n')).toBe(false)
    expect(looksLikeImportablePlan([
      '# Plan',
      '- [ ] 任务一',
      '验收：通过测试',
      '变更范围：src/',
      '风险：回归'
    ].join('\n'))).toBe(true)
  })

  it('workspace 外路径与不存在文件不会导入', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-xforge-resolve-'))
    roots.push(root)
    const session = {
      runJson: vi.fn()
    } as unknown as XForgeMainAgentSession

    expect(await importReferencedValidatedPlan({
      request: '参考 `C:/Windows/outside.md`',
      workspaceRoot: root,
      modelClient: scriptedClient([])
    }, session)).toBeNull()

    expect(await importReferencedValidatedPlan({
      request: '参考 `missing-plan.md`',
      workspaceRoot: root,
      modelClient: scriptedClient([])
    }, session)).toBeNull()
    expect(session.runJson).not.toHaveBeenCalled()
  })

  it('symlink 逃逸工作区时拒绝导入', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-xforge-symlink-ws-'))
    const outside = mkdtempSync(join(tmpdir(), 'nova-xforge-symlink-out-'))
    roots.push(root, outside)
    writeFileSync(join(outside, 'secret.md'), [
      '# Plan',
      '- [ ] 任务',
      '验收：ok',
      '变更范围：x',
      '风险：y'
    ].join('\n'), 'utf8')
    try {
      symlinkSync(outside, join(root, 'escape-link'), 'dir')
    } catch {
      // 无权限创建 symlink 的环境跳过
      return
    }
    const session = { runJson: vi.fn() } as unknown as XForgeMainAgentSession
    expect(await importReferencedValidatedPlan({
      request: '参考 `escape-link/secret.md`',
      workspaceRoot: root,
      modelClient: scriptedClient([])
    }, session)).toBeNull()
    expect(session.runJson).not.toHaveBeenCalled()
  })

  it('非法计划内容不会触发模型规范化', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-xforge-bad-plan-'))
    roots.push(root)
    writeFileSync(join(root, 'notes.md'), 'hello only\n', 'utf8')
    const session = { runJson: vi.fn() } as unknown as XForgeMainAgentSession
    expect(await importReferencedValidatedPlan({
      request: '参考 `notes.md`',
      workspaceRoot: root,
      modelClient: scriptedClient([])
    }, session)).toBeNull()
    expect(session.runJson).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'notes.md'))).toBe(true)
  })

  it('语义分类 abort 时回退到确定性结果并标记 failed', async () => {
    const controller = new AbortController()
    const client: ModelClient = {
      async *chat(_messages, _tools, options) {
        controller.abort()
        if (options?.abortSignal?.aborted) {
          yield { type: 'cancelled' }
          return
        }
        yield { type: 'text_delta', delta: '{}' }
        yield { type: 'message_end', finishReason: 'stop' }
      },
      updateConfig() {}
    }
    const result = await resolveXForgeRequestSignals({
      request: '实现登录页',
      modelClient: client,
      abortSignal: controller.signal
    })
    expect(result.modelSemanticHint).toBe('failed')
  })

  it('语义分类无效 JSON 时回退 failed', async () => {
    const result = await resolveXForgeRequestSignals({
      request: '实现登录页',
      modelClient: scriptedClient(['not-json'])
    })
    expect(result.modelSemanticHint).toBe('failed')
  })
})
