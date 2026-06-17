/**
 * grepTool OutputSink 集成测试
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createGrepTool } from '../../../../src/runtime/tools/grepTool'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import { ArtifactStore } from '../../../../src/runtime/artifacts/ArtifactStore'
import type { ToolContext } from '../../../../src/runtime/tools/types'

const TMP = join(process.cwd(), '.test-workspace-greptool')

function createContext(overrides?: Partial<ToolContext>): ToolContext {
  return { workingDir: TMP, readState: createReadState(), ...overrides }
}

describe('grepTool OutputSink 集成', () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true })
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  it('500+ 匹配的大输出：有 artifactStore 时生成 artifactId 且上下文受控', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'nova-grep-artifact-'))
    const sessionId = 'sess_grep_big'
    const store = new ArtifactStore(sessionsDir)
    const grepTool = createGrepTool()

    // 构造 600 行匹配，每行约 120 字节 → 总量 > 50KB OutputSink 阈值
    const lines = Array.from({ length: 600 }, (_, i) =>
      `GREP_MATCH_${String(i).padStart(4, '0')}: ${'x'.repeat(100)}`
    )
    writeFileSync(join(TMP, 'bigmatches.txt'), lines.join('\n'))

    try {
      const result = await grepTool.execute(
        { pattern: 'GREP_MATCH_', path: '.' },
        createContext({ artifactStore: store, sessionId })
      )

      expect(result.success).toBe(true)
      expect(result.output).toContain('GREP_MATCH_')
      expect(result.artifactId).toBeTruthy()
      expect(result.output).toContain(`artifact://${result.artifactId}`)
      expect(result.truncationMeta?.truncated).toBe(true)

      const full = await store.read(sessionId, result.artifactId!)
      expect(full.split('\n').length).toBe(600)

      // 上下文（含 workspace 标头）应远小于全文
      expect(Buffer.byteLength(result.output ?? '', 'utf8')).toBeLessThan(60_000)
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true })
    }
  })

  it('无 artifactStore 时大输出保持原样（不生成 artifactId）', async () => {
    const grepTool = createGrepTool()
    const lines = Array.from({ length: 600 }, (_, i) =>
      `GREP_MATCH_${String(i).padStart(4, '0')}: ${'x'.repeat(100)}`
    )
    writeFileSync(join(TMP, 'bigmatches2.txt'), lines.join('\n'))

    const result = await grepTool.execute(
      { pattern: 'GREP_MATCH_', path: '.' },
      createContext()
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain('GREP_MATCH_')
    expect(result.artifactId).toBeUndefined()
    expect(result.output).not.toContain('artifact://')
  })

  it('files_with_matches 模式不受 OutputSink 影响', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'nova-grep-fwm-'))
    const sessionId = 'sess_grep_fwm'
    const store = new ArtifactStore(sessionsDir)
    const grepTool = createGrepTool()

    writeFileSync(join(TMP, 'a.txt'), 'needle here\n')
    writeFileSync(join(TMP, 'b.txt'), 'needle there\n')

    try {
      const result = await grepTool.execute(
        { pattern: 'needle', output_mode: 'files_with_matches' },
        createContext({ artifactStore: store, sessionId })
      )

      expect(result.success).toBe(true)
      expect(result.artifactId).toBeUndefined()
      expect(result.output).toContain('a.txt')
      expect(result.output).toContain('b.txt')
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true })
    }
  })

  it('count 模式不受 OutputSink 影响', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'nova-grep-count-'))
    const sessionId = 'sess_grep_count'
    const store = new ArtifactStore(sessionsDir)
    const grepTool = createGrepTool()

    writeFileSync(join(TMP, 'countme.txt'), 'hit\nhit\nhit\n')

    try {
      const result = await grepTool.execute(
        { pattern: 'hit', path: '.', output_mode: 'count' },
        createContext({ artifactStore: store, sessionId })
      )

      expect(result.success).toBe(true)
      expect(result.artifactId).toBeUndefined()
      expect(result.output).toContain('countme.txt: 3')
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true })
    }
  })
})
