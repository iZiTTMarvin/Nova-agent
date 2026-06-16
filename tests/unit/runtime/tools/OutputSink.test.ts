import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ArtifactStore } from '../../../../src/runtime/artifacts/ArtifactStore'
import { OutputSink } from '../../../../src/runtime/tools/OutputSink'

describe('OutputSink', () => {
  let sessionsDir: string
  let store: ArtifactStore
  const sessionId = 'sess_sink'

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), 'nova-sink-'))
    store = new ArtifactStore(sessionsDir)
  })

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true })
  })

  it('小输出原样返回，无 artifactId', async () => {
    const sink = new OutputSink({
      artifactStore: store,
      sessionId,
      toolName: 'grep',
      maxContextBytes: 50_000
    })
    const text = 'small output\nline2'
    const result = await sink.finalize(text)
    expect(result.contextText).toBe(text)
    expect(result.artifactId).toBeUndefined()
    expect(result.truncationNotice).toBe('')
  })

  it('大输出返回 artifactId，contextText 含 artifact 指针且字节数受控', async () => {
    const sink = new OutputSink({
      artifactStore: store,
      sessionId,
      toolName: 'grep',
      maxContextBytes: 2_000
    })
    const lines = Array.from({ length: 500 }, (_, i) => `match line ${i}`).join('\n')
    const result = await sink.finalize(lines)

    expect(result.artifactId).toBeTruthy()
    expect(result.contextText).toContain(`artifact://${result.artifactId}`)
    expect(result.contextText).toContain('续读: read path=')
    expect(Buffer.byteLength(result.contextText, 'utf8')).toBeLessThanOrEqual(2_500)

    const full = await store.read(sessionId, result.artifactId!)
    expect(full).toBe(lines)
  })

  it('截断提示行边界安全，不产生半行乱码', async () => {
    const sink = new OutputSink({
      artifactStore: store,
      sessionId,
      toolName: 'bash',
      maxContextBytes: 80
    })
    const text = Array.from({ length: 30 }, (_, i) => `row-${i}`).join('\n')
    const result = await sink.finalize(text)
    const headLines = result.contextText.split('\n').filter(l => l.startsWith('row-'))
    for (const line of headLines) {
      expect(line).toMatch(/^row-\d+$/)
    }
  })

  it('formatNotice 生成固定格式提示', () => {
    const notice = OutputSink.formatNotice({
      totalLines: 100,
      totalBytes: 5000,
      shownLines: 20,
      artifactId: 'abc123',
      nextOffset: 21
    })
    expect(notice).toContain('artifact://abc123')
    expect(notice).toContain('offset=21')
    expect(notice).toContain('limit=500')
  })
})
