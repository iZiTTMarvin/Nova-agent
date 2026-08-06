/**
 * archive_read 工具测试
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ArtifactStore } from '../../../../src/runtime/artifacts/ArtifactStore'
import { archiveReadTool, ARCHIVE_READ_MAX_RESPONSE_CHARS } from '../../../../src/runtime/tools/archiveRead'
import type { ToolContext } from '../../../../src/runtime/tools/types'
import { createHash } from 'crypto'

describe('archiveReadTool', () => {
  let tmpDir: string
  let store: ArtifactStore
  let sessionId: string
  let toolCtx: ToolContext

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'archive-read-test-'))
    store = new ArtifactStore(tmpDir)
    sessionId = 'test-session'
    toolCtx = {
      workingDir: tmpDir,
      readState: { readFiles: new Set() } as any,
      artifactStore: store,
      sessionId
    }
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeRef(content: string, artifactId: string) {
    const sha256 = createHash('sha256').update(content, 'utf8').digest('hex')
    const bytes = Buffer.byteLength(content, 'utf8')
    return `artifact://${artifactId}?sha256=${sha256}&bytes=${bytes}`
  }

  it('inspect 返回结构信息，不返回正文', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
    const content = lines.join('\n')
    const meta = await store.write(sessionId, content, { toolName: 'test' })
    const ref = makeRef(content, meta.id)

    const result = await archiveReadTool.execute({ ref, operation: 'inspect' }, toolCtx)
    expect(result.success).toBe(true)
    const parsed = JSON.parse(result.output)
    expect(parsed.ok).toBe(true)
    expect(parsed.operation).toBe('inspect')
    expect(parsed.totalBytes).toBe(Buffer.byteLength(content, 'utf8'))
    expect(parsed.totalLines).toBe(20)
    expect(parsed.preview).not.toBe(content)
  })

  it('read 按分页返回正文', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)
    const content = lines.join('\n')
    const meta = await store.write(sessionId, content, { toolName: 'test' })
    const ref = makeRef(content, meta.id)

    const result = await archiveReadTool.execute({ ref, operation: 'read', offset: 1, limit: 10 }, toolCtx)
    expect(result.success).toBe(true)
    const parsed = JSON.parse(result.output)
    expect(parsed.lines).toHaveLength(10)
    expect(parsed.lines[0]).toBe('line 1')
    expect(parsed.hasMore).toBe(true)
    expect(parsed.nextOffset).toBe(11)
    expect(parsed.totalLines).toBe(100)
  })

  it('任意 limit 下响应序列化长度 <= 7500', async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1} with some extra text here`)
    const content = lines.join('\n')
    const meta = await store.write(sessionId, content, { toolName: 'test' })
    const ref = makeRef(content, meta.id)

    const result = await archiveReadTool.execute({ ref, operation: 'read', offset: 1, limit: 100000 }, toolCtx)
    expect(result.success).toBe(true)
    expect(result.output.length).toBeLessThanOrEqual(ARCHIVE_READ_MAX_RESPONSE_CHARS)
  })

  it('search 返回关键词命中行', async () => {
    const lines = [
      'alpha',
      'beta gamma',
      'delta epsilon',
      'beta zeta',
      'theta'
    ]
    const content = lines.join('\n')
    const meta = await store.write(sessionId, content, { toolName: 'test' })
    const ref = makeRef(content, meta.id)

    const result = await archiveReadTool.execute({ ref, operation: 'search', keyword: 'beta' }, toolCtx)
    expect(result.success).toBe(true)
    const parsed = JSON.parse(result.output)
    expect(parsed.totalMatches).toBe(2)
    expect(parsed.matches[0].line).toBe(2)
    expect(parsed.matches[0].content).toBe('beta gamma')
    expect(parsed.matches[0].contextBefore).toBe('alpha')
    expect(parsed.matches[0].contextAfter).toBe('delta epsilon')
  })

  it('sha256 不匹配时返回含 expected/actual 的结构化错误', async () => {
    const content = 'hello world'
    const meta = await store.write(sessionId, content, { toolName: 'test' })
    // 使用错误 sha256 构造 ref
    const wrongSha = createHash('sha256').update('different content', 'utf8').digest('hex')
    const bytes = Buffer.byteLength(content, 'utf8')
    const ref = `artifact://${meta.id}?sha256=${wrongSha}&bytes=${bytes}`

    const result = await archiveReadTool.execute({ ref }, toolCtx)
    expect(result.success).toBe(false)
    const err = JSON.parse(result.error!)
    expect(err.error).toBe('integrity_mismatch')
    expect(err.expected).toBe(wrongSha)
    expect(err.actual).toBe(createHash('sha256').update(content, 'utf8').digest('hex'))
    expect(err.artifactId).toBe(meta.id)
  })

  it('缺失 hash 的旧指针仍可读（兼容）', async () => {
    const content = 'legacy artifact body'
    const meta = await store.write(sessionId, content, { toolName: 'test' })
    const result = await archiveReadTool.execute(
      { ref: `artifact://${meta.id}`, operation: 'inspect' },
      toolCtx
    )
    expect(result.success).toBe(true)
    const parsed = JSON.parse(result.output)
    expect(parsed.ok).toBe(true)
    expect(parsed.totalBytes).toBe(Buffer.byteLength(content, 'utf8'))
  })

  it('无效 ref 格式返回失败', async () => {
    const result = await archiveReadTool.execute({ ref: 'not-a-valid-ref' }, toolCtx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('无效')
  })
})
