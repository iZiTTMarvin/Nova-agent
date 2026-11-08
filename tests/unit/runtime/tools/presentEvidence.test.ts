import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { createPresentEvidenceTool } from '../../../../src/runtime/tools/present_evidence'
import { SessionStore } from '../../../../src/runtime/sessions/SessionStore'
import { ImageStore } from '../../../../src/runtime/storage/ImageStore'
import { ArtifactStore } from '../../../../src/runtime/artifacts/ArtifactStore'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import type { ToolContext } from '../../../../src/runtime/tools/types'
import type { EvidenceReference } from '../../../../src/shared/evidence'

describe('present_evidence 的真实产物边界', () => {
  let root: string
  let sessions: SessionStore
  let images: ImageStore
  let artifacts: ArtifactStore
  let context: ToolContext
  let reference: EvidenceReference
  let tool: ReturnType<typeof createPresentEvidenceTool>

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'nova-evidence-'))
    sessions = new SessionStore(root)
    const session = sessions.create(root, 'pilot')
    images = new ImageStore(sessions.getSessionsDir())
    artifacts = new ArtifactStore(sessions.getSessionsDir())
    context = { workingDir: root, readState: createReadState(), sessionId: session.id, sessionStore: sessions, artifactStore: artifacts }
    const png = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#fff' } }).png().toBuffer()
    const saved = images.save(session.id, `data:image/png;base64,${png.toString('base64')}`)
    reference = { ...await images.resolveEvidence(session.id, saved.url), sourceTool: 'browser_capture', description: '原始截图' }
    sessions.appendMessage(session.id, { id: 'source', role: 'assistant', content: '', timestamp: 1,
      blocks: [{ type: 'tool', toolCallId: 'capture', toolName: 'browser_capture', arguments: {}, status: 'success', evidence: [reference] }] })
    tool = createPresentEvidenceTool({ getImageStore: () => images, getReferences: ctx =>
      sessions.load(ctx.sessionId!)?.messages.flatMap(msg => msg.blocks?.flatMap(block => block.type === 'tool' ? block.evidence ?? [] : []) ?? []) ?? [] })
  })
  afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

  function selection(ref = reference): Record<string, unknown> {
    return { items: [{ kind: ref.kind, ...(ref.kind === 'image' ? { url: ref.url } : { artifactId: ref.artifactId }), description: '点击重置后的画面' }] }
  }

  it('选择已保存图片与日志，保留来源并能从磁盘恢复，不产生通过结论', async () => {
    const meta = await artifacts.write(context.sessionId!, 'exit=1\nassertion failed', { toolName: 'bash' })
    const log = await artifacts.resolveEvidence(context.sessionId!, meta.id, 'bash')
    sessions.appendMessage(context.sessionId!, { id: 'log', role: 'assistant', content: '', timestamp: 2,
      blocks: [{ type: 'tool', toolCallId: 'bash', toolName: 'bash', arguments: {}, status: 'error', evidence: [log] }] })
    const result = await tool.execute({ items: [
      ...(selection().items as unknown[]), { kind: 'artifact', artifactId: meta.id, description: '失败日志' }
    ] }, context)
    expect(result.success).toBe(true)
    expect(result.evidence).toEqual([{ ...reference, description: '点击重置后的画面' }, { ...log, description: '失败日志' }])
    expect(result).not.toHaveProperty('verdict')
    expect(JSON.stringify(result.evidence)).not.toMatch(/base64|filePath|resultImages/)
    expect(await artifacts.readEvidence(context.sessionId!, meta.id)).toContain('assertion failed')
    sessions.appendMessage(context.sessionId!, { id: 'delivery', role: 'assistant', content: '', timestamp: 3,
      blocks: [{ type: 'tool', toolCallId: 'delivery', toolName: 'present_evidence', arguments: {}, status: 'success', evidence: result.evidence }] })
    expect(new SessionStore(root).load(context.sessionId!)?.messages.at(-1)?.blocks?.[0]).toMatchObject({ evidence: result.evidence })
  })

  it('拒绝任意路径、URL、未签发引用、verdict 和模型指定会话', async () => {
    for (const args of [
      { items: [{ kind: 'image', url: 'C:\\secret.png', description: 'x' }] },
      { items: [{ kind: 'image', url: 'https://example.com/a.png', description: 'x' }] },
      { items: [{ kind: 'artifact', artifactId: 'a'.repeat(12), description: 'x' }] },
      { ...selection(), verdict: 'pass' }, { ...selection(), sessionId: context.sessionId }
    ]) {
      const result = await tool.execute(args, context)
      expect(result.success).toBe(false)
      expect(result.evidence).toBeUndefined()
    }
  })

  it('拒绝跨会话引用，即使另一会话的文件真实存在', async () => {
    const other = sessions.create(root, 'pilot')
    const result = await tool.execute(selection(), { ...context, sessionId: other.id })
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('当前会话') })
    // 即使错误宿主给出外来引用，ImageStore 仍校验 URL 归属。
    const misbound = createPresentEvidenceTool({ getImageStore: () => images, getReferences: () => [reference] })
    expect(await misbound.execute(selection(), { ...context, sessionId: other.id })).toMatchObject({ success: false })
  })

  it('拒绝损坏图片和缺失 Artifact，不返回部分选择', async () => {
    if (reference.kind !== 'image') throw new Error('expected image')
    writeFileSync(images.resolveUrl(reference.url)!.filePath, 'broken')
    expect(await tool.execute(selection(), context)).toMatchObject({ success: false, error: expect.stringContaining('损坏') })
    const meta = await artifacts.write(context.sessionId!, 'log', { toolName: 'bash' })
    const ref = await artifacts.resolveEvidence(context.sessionId!, meta.id, 'bash')
    const missingTool = createPresentEvidenceTool({ getImageStore: () => images, getReferences: () => [ref] })
    unlinkSync(artifacts.resolvePath(context.sessionId!, meta.id))
    expect(await missingTool.execute(selection(ref), context)).toMatchObject({ success: false })
  })

  it('取消、过期 generation 和异步读取期间删除会话均不签发展示结果', async () => {
    const abort = new AbortController()
    abort.abort()
    expect(await tool.execute(selection(), { ...context, abortSignal: abort.signal })).toMatchObject({ success: false })
    expect(await tool.execute(selection(), { ...context, assertExecutionCurrent: () => false })).toMatchObject({ success: false })
    const resolve = images.resolveEvidence.bind(images)
    vi.spyOn(images, 'resolveEvidence').mockImplementation(async (...args) => {
      const media = await resolve(...args)
      sessions.delete(context.sessionId!)
      return media
    })
    expect(await tool.execute(selection(), context)).toMatchObject({ success: false, error: expect.stringContaining('删除') })
    expect(sessions.load(context.sessionId!)).toBeNull()
  })
})
