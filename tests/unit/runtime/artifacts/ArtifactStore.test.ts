import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ArtifactStore } from '../../../../src/runtime/artifacts/ArtifactStore'

describe('ArtifactStore', () => {
  let sessionsDir: string
  let store: ArtifactStore
  const sessionId = 'sess_art'

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), 'nova-artifact-'))
    store = new ArtifactStore(sessionsDir)
  })

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true })
  })

  it('write / read 往返一致', async () => {
    const content = 'line1\nline2\nline3'
    const meta = await store.write(sessionId, content, { toolName: 'grep' })
    const readBack = await store.read(sessionId, meta.id)
    expect(readBack).toBe(content)
    expect(meta.totalBytes).toBe(Buffer.byteLength(content, 'utf8'))
    expect(meta.totalLines).toBe(3)
  })

  it('writeFromPath 将源文件移入 artifact 目录', async () => {
    const sourcePath = join(sessionsDir, 'source.log')
    const { writeFileSync } = await import('fs')
    const fullText = 'A'.repeat(5000)
    writeFileSync(sourcePath, fullText, 'utf8')

    const meta = await store.writeFromPath(sessionId, sourcePath, { toolName: 'bash' })
    expect(existsSync(sourcePath)).toBe(false)
    expect(existsSync(store.resolvePath(sessionId, meta.id))).toBe(true)
    expect(readFileSync(store.resolvePath(sessionId, meta.id), 'utf8')).toBe(fullText)
  })

  it('并发写入生成不同 ID', async () => {
    const [a, b] = await Promise.all([
      store.write(sessionId, 'a', { toolName: 'bash' }),
      store.write(sessionId, 'b', { toolName: 'bash' })
    ])
    expect(a.id).not.toBe(b.id)
  })

  it('resolvePath 返回路径位于会话 artifacts 目录下', () => {
    const id = 'abc123'
    const resolved = store.resolvePath(sessionId, id)
    expect(resolved).toContain(join(sessionId, 'artifacts', id))
    expect(resolved.startsWith(sessionsDir)).toBe(true)
  })

  it('resolvePath 拒绝非法 sessionId 与 artifactId', () => {
    expect(() => store.resolvePath('../evil', 'abc')).toThrow(/非法 sessionId/)
    expect(() => store.resolvePath(sessionId, '../evil')).toThrow(/非法 artifactId/)
  })

  it('read 支持 offset / limit 行切片', async () => {
    const content = 'l1\nl2\nl3\nl4\nl5'
    const meta = await store.write(sessionId, content, { toolName: 'read' })
    const slice = await store.read(sessionId, meta.id, { offset: 2, limit: 2 })
    expect(slice).toBe('l2\nl3')
  })
})
