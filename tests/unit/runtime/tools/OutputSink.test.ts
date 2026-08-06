import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ArtifactStore } from '../../../../src/runtime/artifacts/ArtifactStore'
import { sha256Hex } from '../../../../src/runtime/artifacts/artifactRef'
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
    expect(result.truncationMeta?.truncated).toBe(false)
    expect(result.truncationMeta?.shownLines).toBe(2)
  })

  it('大输出返回 artifactId，contextText 含带 hash 的 artifact 指针且字节数受控', async () => {
    const sink = new OutputSink({
      artifactStore: store,
      sessionId,
      toolName: 'grep',
      maxContextBytes: 2_000
    })
    const lines = Array.from({ length: 500 }, (_, i) => `match line ${i}`).join('\n')
    const result = await sink.finalize(lines)

    expect(result.artifactId).toBeTruthy()
    expect(result.contextText).toContain(`artifact://${result.artifactId}?sha256=`)
    expect(result.contextText).toContain('&bytes=')
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

  it('超限输出保留头尾：含头部行、省略标记、尾部行与 notice', async () => {
    const sink = new OutputSink({
      artifactStore: store,
      sessionId,
      toolName: 'bash',
      maxContextBytes: 2_000
    })
    // 每行 9 字节：head 预算 1200 字节 → 120 行，tail 预算 800 字节 → 80 行
    const lines = Array.from({ length: 500 }, (_, i) => `line-${String(i).padStart(4, '0')}`)
    const text = lines.join('\n')
    const totalBytes = Buffer.byteLength(text, 'utf8')
    const result = await sink.finalize(text)

    const contextLines = result.contextText.split('\n')
    // 头部从原文第一行开始，尾部以原文最后一行收尾
    expect(contextLines[0]).toBe('line-0000')
    const noticeStart = contextLines.findIndex(l => l.startsWith('[输出已截断'))
    expect(noticeStart).toBeGreaterThan(0)
    expect(contextLines[noticeStart - 1]).toBe('line-0499')

    // 结构顺序：head → 省略标记（省略行数正确）→ tail → notice
    const markerIndex = contextLines.findIndex(l => l === '[已省略中间 300 行]')
    expect(markerIndex).toBeGreaterThan(0)
    expect(contextLines[markerIndex - 1]).toBe('line-0119')
    expect(contextLines[markerIndex + 1]).toBe('line-0420')
    expect(markerIndex).toBeLessThan(noticeStart)

    // 指针协议不变：artifactId 透传，nextOffset = head 行数 + 1
    const ref = `artifact://${result.artifactId}?sha256=${sha256Hex(text)}&bytes=${totalBytes}`
    expect(contextLines[noticeStart]).toBe(`[输出已截断: 共 500 行 / ${totalBytes} 字节。上下文保留 200 行。`)
    expect(contextLines[noticeStart + 1]).toBe(`完整输出: ${ref}`)
    expect(contextLines[noticeStart + 2]).toBe(`续读: read path="${ref}" offset=121 limit=500]`)

    expect(result.truncationMeta).toEqual({
      totalBytes,
      totalLines: 500,
      shownLines: 200,
      truncated: true
    })
  })

  it('行边界：上下文中保留的行均为原文完整行', async () => {
    const sink = new OutputSink({
      artifactStore: store,
      sessionId,
      toolName: 'bash',
      maxContextBytes: 1_500
    })
    const lines = Array.from({ length: 200 }, (_, i) => `row-${i}-${'x'.repeat(40)}`)
    const result = await sink.finalize(lines.join('\n'))

    const original = new Set(lines)
    const contextLines = result.contextText.split('\n')
    const noticeStart = contextLines.findIndex(l => l.startsWith('[输出已截断'))
    const kept = contextLines.slice(0, noticeStart).filter(l => !l.startsWith('[已省略中间'))
    expect(kept.length).toBeGreaterThan(0)
    for (const line of kept) {
      expect(original.has(line)).toBe(true)
    }
    // head 末行与 tail 首行都是完整行，尾块最后一行即原文最后一行
    expect(kept[kept.length - 1]).toBe(lines[lines.length - 1])
  })

  it('总行数不多但总字节超限：省略标记按实际省略行数表述', async () => {
    const sink = new OutputSink({
      artifactStore: store,
      sessionId,
      toolName: 'bash',
      maxContextBytes: 2_000
    })
    // 10 行 × 300 字节：head 预算 1200 → 3 行，tail 预算 800 → 2 行
    const lines = Array.from({ length: 10 }, (_, i) => `${i}:` + 'a'.repeat(298))
    const result = await sink.finalize(lines.join('\n'))

    expect(result.contextText).toContain('[已省略中间 5 行]')
    expect(result.contextText).not.toMatch(/已省略中间 -/)
    expect(result.truncationMeta?.shownLines).toBe(5)
  })

  it('少量超长行导致纯字节超限时不出现省略标记', async () => {
    const sink = new OutputSink({
      artifactStore: store,
      sessionId,
      toolName: 'bash',
      maxContextBytes: 2_000
    })
    const line1 = 'H'.repeat(1500)
    const line2 = 'T'.repeat(1500)
    const result = await sink.finalize(`${line1}\n${line2}`)

    // 两行分别被头/尾按字节部分保留，没有整行被省略，不出中间标记
    expect(result.contextText).not.toContain('已省略')
    expect(result.contextText).toContain('[输出已截断: 共 2 行')
    expect(result.contextText.startsWith(line1.slice(0, 100))).toBe(true)
    expect(result.contextText).toContain(line2.slice(-100))
    expect(result.truncationMeta?.shownLines).toBe(2)
  })

  it('预算极小导致头尾为空时优雅退化，不产生连续空行', async () => {
    const sink = new OutputSink({
      artifactStore: store,
      sessionId,
      toolName: 'bash',
      maxContextBytes: 100,
      maxContextLines: 1
    })
    const text = Array.from({ length: 50 }, (_, i) => `r${i}${'r'.repeat(8)}`).join('\n')
    const result = await sink.finalize(text)

    expect(result.artifactId).toBeTruthy()
    expect(result.contextText).not.toContain('\n\n')
    expect(result.contextText).toContain('[已省略中间 50 行]')
    expect(result.contextText).toContain('[输出已截断: 共 50 行')
    expect(result.truncationMeta?.shownLines).toBe(0)
  })

  it('formatNotice 生成含 sha256 的固定格式提示', () => {
    const notice = OutputSink.formatNotice({
      totalLines: 100,
      totalBytes: 5000,
      shownLines: 20,
      artifactId: 'abc123',
      sha256: 'deadbeef',
      nextOffset: 21
    })
    expect(notice).toContain('artifact://abc123?sha256=deadbeef&bytes=5000')
    expect(notice).toContain('offset=21')
    expect(notice).toContain('limit=500')
  })
})
