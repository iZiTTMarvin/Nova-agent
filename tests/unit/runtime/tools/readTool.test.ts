import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'fs'
import { join } from 'path'
import sharp from 'sharp'
import {
  readTool,
  isBinaryExtension,
  formatFileSize,
  applySafetyTruncation,
  buildContinuationHint,
} from '../../../../src/runtime/tools/readTool'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import { encodeFile } from '../../../../src/runtime/tools/editDiff'
import type { ToolContext } from '../../../../src/runtime/tools/types'
import { ArtifactStore } from '../../../../src/runtime/artifacts/ArtifactStore'
import { mkdtempSync, rmSync as rmSyncOs } from 'fs'
import { tmpdir } from 'os'
import { MIN_SUMMARY_LINES } from '../../../../src/runtime/tools/readSummarizer'

const TMP = join(process.cwd(), '.test-workspace-readtool')

/**
 * readTool 成功路径会在输出最前面加一行 `[workspace: <abs path>]` 标头
 * （session context 注入的双保险）。测试断言文件正文内容时需要剥掉这一行。
 * 仅在 output 以该标头开头时剥离，其余原样返回。
 */
function stripWorkspaceHeader(output: string): string {
  const prefix = `[workspace: ${TMP}]\n`
  return output.startsWith(prefix) ? output.slice(prefix.length) : output
}

/** 测试用 readState：beforeEach 中重建（与 I1 行为对齐） */
let testReadState = createReadState()

function createContext(overrides?: Partial<ToolContext>): ToolContext {
  return { workingDir: TMP, readState: testReadState, ...overrides }
}

/** 用 sharp 生成 1×1 PNG */
async function createTestPng(): Promise<Buffer> {
  return sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .png()
    .toBuffer()
}

/** 用 sharp 生成 1×1 JPEG */
async function createTestJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .jpeg()
    .toBuffer()
}

describe('readTool', () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true })
    testReadState = createReadState()
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  // ── 基础读取 ────────────────────────────────────────────

  describe('基础功能', () => {
    it('读取文本文件内容', async () => {
      writeFileSync(join(TMP, 'hello.txt'), 'hello world\nline2\nline3\n')
      const result = await readTool.execute({ path: 'hello.txt' }, createContext())
      expect(result.success).toBe(true)
      expect(stripWorkspaceHeader(result.output)).toBe('hello world\nline2\nline3\n')
    })

    it('读取子目录中的文件', async () => {
      mkdirSync(join(TMP, 'nested'), { recursive: true })
      writeFileSync(join(TMP, 'nested', 'main.ts'), 'const x = 1\n')
      const result = await readTool.execute({ path: 'nested/main.ts' }, createContext())
      expect(result.success).toBe(true)
      expect(result.output).toContain('const x = 1')
    })

    it('读取空文件', async () => {
      writeFileSync(join(TMP, 'empty.txt'), '')
      const result = await readTool.execute({ path: 'empty.txt' }, createContext())
      expect(result.success).toBe(true)
      expect(stripWorkspaceHeader(result.output)).toBe('')
    })
  })

  // ── 参数校验 ────────────────────────────────────────────

  describe('参数校验', () => {
    it('缺少 path 参数返回错误', async () => {
      const result = await readTool.execute({}, createContext())
      expect(result.success).toBe(false)
      expect(result.error).toContain('缺少 path 参数')
    })

    it('文件不存在返回友好错误', async () => {
      const result = await readTool.execute({ path: 'nonexistent.txt' }, createContext())
      expect(result.success).toBe(false)
      expect(result.error).toContain('文件不存在')
    })

    it('路径越界被拒绝', async () => {
      const result = await readTool.execute(
        { path: '../../../etc/passwd' },
        createContext(),
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('越界')
    })
  })

  // ── 二进制检测 ──────────────────────────────────────────

  describe('二进制检测', () => {
    it('通过扩展名拒绝二进制文件', async () => {
      writeFileSync(join(TMP, 'file.exe'), Buffer.from([0x4d, 0x5a, 0x90, 0x00]))
      const result = await readTool.execute({ path: 'file.exe' }, createContext())
      expect(result.success).toBe(false)
      expect(result.error).toContain('二进制文件')
      expect(result.error).toContain('.exe')
    })

    it('通过空字节扫描拒绝二进制文件', async () => {
      // 使用 .txt 扩展名（不是已知二进制扩展名），内容含空字节
      writeFileSync(join(TMP, 'nullbytes.txt'), Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6c, 0x6f]))
      const result = await readTool.execute({ path: 'nullbytes.txt' }, createContext())
      expect(result.success).toBe(false)
      expect(result.error).toContain('二进制文件')
      expect(result.error).toContain('含空字节')
    })

    it('普通文本文件含空字节也能拒', async () => {
      const buf = Buffer.alloc(100)
      buf.write('hello world\x00more text', 0)
      writeFileSync(join(TMP, 'corrupted.txt'), buf)
      const result = await readTool.execute({ path: 'corrupted.txt' }, createContext())
      expect(result.success).toBe(false)
      expect(result.error).toContain('含空字节')
    })
  })

  // ── 文件大小预检 ────────────────────────────────────────

  describe('文件大小预检', () => {
    it('大文件（>256KB）且无 offset/limit 时拒绝', async () => {
      const bigStr = 'x'.repeat(257 * 1024)
      writeFileSync(join(TMP, 'bigfile.txt'), bigStr)
      const result = await readTool.execute({ path: 'bigfile.txt' }, createContext())
      expect(result.success).toBe(false)
      expect(result.error).toContain('文件过大')
      expect(result.error).toContain('offset')
    })

    it('大文件 + offset/limit 允许读取', async () => {
      // 构造 >256KB 的文件
      const bigStr = 'x'.repeat(300 * 1024) // 300KB
      writeFileSync(join(TMP, 'bigfile.txt'), bigStr)
      // 不传分页参数 → 拒绝
      const reject = await readTool.execute({ path: 'bigfile.txt' }, createContext())
      expect(reject.success).toBe(false)
      expect(reject.error).toContain('文件过大')
      // 传 offset+limit → 允许（即使是只读 1 行）
      const result = await readTool.execute(
        { path: 'bigfile.txt', offset: 0, limit: 1 },
        createContext(),
      )
      expect(result.success).toBe(true)
    })

    it('只传 offset 不传 limit 的大文件允许读取', async () => {
      // >256KB，只传 offset 说明用户想分页，也应允许
      const bigStr = 'y'.repeat(300 * 1024)
      writeFileSync(join(TMP, 'bigoffset.txt'), bigStr)
      const result = await readTool.execute(
        { path: 'bigoffset.txt', offset: 100 },
        createContext(),
      )
      expect(result.success).toBe(true)
    })
  })

  // ── offset/limit 切片 ──────────────────────────────────

  describe('offset/limit', () => {
    it('读取指定行范围', async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`)
      writeFileSync(join(TMP, 'lines.txt'), lines.join('\n'))
      const result = await readTool.execute(
        { path: 'lines.txt', offset: 10, limit: 5 },
        createContext(),
      )
      expect(result.success).toBe(true)
      expect(stripWorkspaceHeader(result.output)).toBe('line 10\nline 11\nline 12\nline 13\nline 14')
    })

    it('offset 超出文件行数返回空结果', async () => {
      writeFileSync(join(TMP, 'short.txt'), 'line1\nline2\n')
      const result = await readTool.execute(
        { path: 'short.txt', offset: 100 },
        createContext(),
      )
      expect(result.success).toBe(true)
      expect(stripWorkspaceHeader(result.output)).toBe('')
    })

    it('只使用 offset 不使用 limit 时从 offset 读到末尾', async () => {
      const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`)
      writeFileSync(join(TMP, 'partial.txt'), lines.join('\n'))
      const result = await readTool.execute(
        { path: 'partial.txt', offset: 8 },
        createContext(),
      )
      expect(result.success).toBe(true)
      expect(stripWorkspaceHeader(result.output)).toBe('line 8\nline 9')
    })
  })

  // ── 安全截断 ────────────────────────────────────────────

  describe('安全截断', () => {
    it('超过 2000 行自动截断 + 续读提示', async () => {
      const lines = Array.from({ length: 2500 }, (_, i) => `line ${i}`)
      writeFileSync(join(TMP, 'long.txt'), lines.join('\n'))
      const result = await readTool.execute({ path: 'long.txt' }, createContext())
      expect(result.success).toBe(true)

      const outputLines = result.output.split('\n')
      // 2000 行 + 续读提示
      const hintLine = outputLines.find(l => l.startsWith('[显示'))
      expect(hintLine).toBeDefined()
      expect(hintLine).toContain('1-2000')
      expect(hintLine).toContain('共 2500 行')
      expect(hintLine).toContain('继续读取')
    })

    it('超过 2000 行 + offset/limit 不受影响', async () => {
      const lines = Array.from({ length: 2500 }, (_, i) => `line ${i}`)
      writeFileSync(join(TMP, 'long2.txt'), lines.join('\n'))
      const result = await readTool.execute(
        { path: 'long2.txt', offset: 2000, limit: 500 },
        createContext(),
      )
      expect(result.success).toBe(true)
      // 请求 2000-2499，共 500 行 < 2000，不应截断（剥掉 [workspace:] 标头后再统计）
      const outputLines = stripWorkspaceHeader(result.output).split('\n')
      expect(outputLines.length).toBe(500)
      expect(outputLines[0]).toBe('line 2000')
      expect(outputLines[499]).toBe('line 2499')
    })

    it('单行超过 1000 字符被截断', async () => {
      const longLine = 'a'.repeat(1200)
      writeFileSync(join(TMP, 'longline.txt'), longLine)
      const result = await readTool.execute({ path: 'longline.txt' }, createContext())
      expect(result.success).toBe(true)
      expect(result.output).toContain('...[截断]')
      expect(result.output.length).toBeLessThan(1200)
    })

    it('字节超过 100KB 被截断 + 续读提示', async () => {
      // 构造：每行 200 字节，共 800 行 ≈ 160KB（>100KB 且 <2000 行）
      const line = 'x'.repeat(199) + '\n'
      const content = Array.from({ length: 800 }, () => line).join('')
      writeFileSync(join(TMP, 'bigbytes.txt'), content)
      const result = await readTool.execute({ path: 'bigbytes.txt' }, createContext())
      expect(result.success).toBe(true)
      expect(result.output).toContain('[显示')
      const outputBytes = Buffer.byteLength(result.output, 'utf-8')
      // 允许略超过 100KB（因为加上续读提示）
      expect(outputBytes).toBeLessThan(120 * 1024)
    })
  })

  // ── 纯函数测试 ──────────────────────────────────────────

  describe('纯函数', () => {
    it('isBinaryExtension 识别已知扩展名', () => {
      expect(isBinaryExtension('file.exe')).toBe(true)
      expect(isBinaryExtension('file.pdf')).toBe(true)
      // .png 不在 BINARY_EXTENSIONS 中（走图片 MIME 检测路径）
      expect(isBinaryExtension('image.png')).toBe(false)
      expect(isBinaryExtension('file.txt')).toBe(false)
      expect(isBinaryExtension('file.ts')).toBe(false)
    })

    it('formatFileSize 正确格式化', () => {
      expect(formatFileSize(500)).toBe('500 B')
      expect(formatFileSize(2048)).toBe('2.0 KB')
      expect(formatFileSize(1024 * 1024 * 2)).toBe('2.0 MB')
    })

    it('applySafetyTruncation 不截断短内容', () => {
      const result = applySafetyTruncation(['hello', 'world'])
      expect(result.truncated).toBe(false)
      expect(result.linesText).toBe('hello\nworld')
    })

    it('applySafetyTruncation 截断长行', () => {
      const longLine = 'a'.repeat(1001)
      const result = applySafetyTruncation([longLine])
      expect(result.truncated).toBe(true)
      expect(result.linesText).toContain('...[截断]')
      expect(result.linesText.length).toBe(1000 + 7) // 截断 + '...[截断]'
    })

    it('buildContinuationHint 仅在截断时生成', () => {
      const hint = buildContinuationHint(0, 100, 500, true)
      expect(hint).toContain('显示 1-100 行')
      expect(hint).toContain('共 500 行')
      expect(hint).toContain('offset=100')
    })

    it('buildContinuationHint 未截断时返回空', () => {
      const hint = buildContinuationHint(0, 100, 100, false)
      expect(hint).toBe('')
    })
  })

  // ── readState ───────────────────────────────────────────

  describe('readState', () => {
    it('正确写入 readState', async () => {
      writeFileSync(join(TMP, 'state.txt'), 'content for state\nline2\n')
      await readTool.execute({ path: 'state.txt' }, createContext())

      const absPath = join(TMP, 'state.txt')
      const state = testReadState.get(absPath)
      expect(state).toBeDefined()
      expect(state!.content).toBe('content for state\nline2\n')
      expect(state!.timestamp).toBeGreaterThan(0)
    })
  })

  // ── 编码检测 ────────────────────────────────────────────

  describe('编码检测', () => {
    it('正确读取 GBK 编码文件', async () => {
      const buf = encodeFile('你好世界\nline2', 'gbk')
      writeFileSync(join(TMP, 'gbk.txt'), buf)
      const result = await readTool.execute({ path: 'gbk.txt' }, createContext())
      expect(result.success).toBe(true)
      expect(result.output).toContain('你好世界')
    })

    it('正确读取 UTF-16LE 编码文件', async () => {
      const buf = encodeFile('hello 中文\nline2', 'utf-16le')
      writeFileSync(join(TMP, 'utf16le.txt'), buf)
      const result = await readTool.execute({ path: 'utf16le.txt' }, createContext())
      expect(result.success).toBe(true)
      // UTF-16LE 的文本内容不含 U+0000，null 字节检测对 decoded text 不触发
      expect(result.output).toContain('hello 中文')
    })

    it('正确读取 UTF-8 BOM 文件', async () => {
      const buf = encodeFile('bom content\nline2', 'utf-8-bom')
      writeFileSync(join(TMP, 'bom.txt'), buf)
      const result = await readTool.execute({ path: 'bom.txt' }, createContext())
      expect(result.success).toBe(true)
      expect(stripWorkspaceHeader(result.output)).toBe('bom content\nline2')
      expect(result.output).not.toContain('\uFEFF')
    })
  })

  // ── abortSignal ─────────────────────────────────────────

  describe('abortSignal', () => {
    it('abortSignal 取消时返回友好错误', async () => {
      writeFileSync(join(TMP, 'cancel.txt'), 'content\n')
      const ac = new AbortController()
      ac.abort()

      const result = await readTool.execute(
        { path: 'cancel.txt' },
        createContext({ abortSignal: ac.signal }),
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('已取消')
    })
  })

  // ── 图片检测 ─────────────────────────────────────────────

  describe('图片检测', () => {
    it('读取有效 PNG 图片返回图片数据', async () => {
      const pngBuf = await createTestPng()
      writeFileSync(join(TMP, 'test.png'), pngBuf)

      const result = await readTool.execute(
        { path: 'test.png' },
        createContext({ supportsVision: true }),
      )
      expect(result.success).toBe(true)
      expect(result.output).toContain('image/png')
      expect(result.images).toBeDefined()
      expect(result.images!.length).toBe(1)
      expect(result.images![0].mimeType).toBe('image/png')
      expect(result.images![0].data.length).toBeGreaterThan(0)
    })

    it('读取有效 JPEG 图片返回图片数据', async () => {
      const jpegBuf = await createTestJpeg()
      writeFileSync(join(TMP, 'photo.jpg'), jpegBuf)

      const result = await readTool.execute(
        { path: 'photo.jpg' },
        createContext({ supportsVision: true }),
      )
      expect(result.success).toBe(true)
      expect(result.output).toContain('image/jpeg')
      expect(result.images).toBeDefined()
      expect(result.images!.length).toBe(1)
    })

    it('模型不支持 vision 时返回文字提示而非图片', async () => {
      const pngBuf = await createTestPng()
      writeFileSync(join(TMP, 'novision.png'), pngBuf)

      const result = await readTool.execute(
        { path: 'novision.png' },
        createContext({ supportsVision: false }),
      )
      expect(result.success).toBe(true)
      expect(result.output).toContain('不支持图片输入')
      expect(result.images).toBeUndefined()
    })

    it('无效图片文件返回错误', async () => {
      // .png 扩展名但内容不是有效图片
      writeFileSync(join(TMP, 'fake.png'), 'not a real png file')

      const result = await readTool.execute(
        { path: 'fake.png' },
        createContext({ supportsVision: true }),
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('无法识别为有效图片文件')
    })

    it('图片文件不写入 readState', async () => {
      const pngBuf = await createTestPng()
      writeFileSync(join(TMP, 'statecheck.png'), pngBuf)

      await readTool.execute(
        { path: 'statecheck.png' },
        createContext({ supportsVision: true }),
      )

      const absPath = join(TMP, 'statecheck.png')
      expect(testReadState.get(absPath)).toBeUndefined()
    })
  })

  // ── artifact:// 续读 ─────────────────────────────────────

  describe('artifact:// 续读', () => {
    it('read path="artifact://{id}" offset/limit 返回正确片段', async () => {
      const sessionsDir = mkdtempSync(join(tmpdir(), 'nova-read-artifact-'))
      const sessionId = 'sess_read_art'
      const store = new ArtifactStore(sessionsDir)

      const lines = Array.from({ length: 200 }, (_, i) => `line-${i}`)
      const meta = await store.write(sessionId, lines.join('\n'), { toolName: 'bash' })

      try {
        const result = await readTool.execute(
          { path: `artifact://${meta.id}`, offset: 100, limit: 50 },
          createContext({ artifactStore: store, sessionId })
        )

        expect(result.success).toBe(true)
        const body = stripWorkspaceHeader(result.output)
        const outputLines = body.split('\n').filter(l => !l.startsWith('[显示'))
        expect(outputLines[0]).toBe('line-100')
        expect(outputLines[49]).toBe('line-149')
        expect(outputLines.length).toBe(50)

        // readState 保存真实切片（截断前）
        const state = testReadState.get(`artifact://${meta.id}`)
        expect(state).toBeDefined()
        expect(state!.content.split('\n').length).toBe(50)
        expect(state!.content.startsWith('line-100')).toBe(true)
      } finally {
        rmSyncOs(sessionsDir, { recursive: true, force: true })
      }
    })

    it('缺少 artifactStore 时 artifact 路径报错', async () => {
      const result = await readTool.execute(
        { path: 'artifact://deadbeef' },
        createContext()
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('artifactStore')
    })

    it('artifact 不存在时返回友好错误', async () => {
      const sessionsDir = mkdtempSync(join(tmpdir(), 'nova-read-art-missing-'))
      const sessionId = 'sess_missing'
      const store = new ArtifactStore(sessionsDir)

      try {
        const result = await readTool.execute(
          { path: 'artifact://notexist12' },
          createContext({ artifactStore: store, sessionId })
        )
        expect(result.success).toBe(false)
        expect(result.error).toContain('不存在')
      } finally {
        rmSyncOs(sessionsDir, { recursive: true, force: true })
      }
    })
  })

  // ── OutputSink 二次控量 ───────────────────────────────────

  describe('OutputSink 二次控量', () => {
    it('大文件读取有 artifactStore 时生成 artifactId', async () => {
      const sessionsDir = mkdtempSync(join(tmpdir(), 'nova-read-sink-'))
      const sessionId = 'sess_read_sink'
      const store = new ArtifactStore(sessionsDir)

      // 800 行 × 200 字节 ≈ 160KB，超过 read 安全截断 100KB，再触发 OutputSink 50KB
      const line = 'z'.repeat(199)
      const content = Array.from({ length: 800 }, () => line).join('\n')
      writeFileSync(join(TMP, 'huge.txt'), content)

      try {
        const result = await readTool.execute(
          { path: 'huge.txt' },
          createContext({ artifactStore: store, sessionId })
        )

        expect(result.success).toBe(true)
        expect(result.artifactId).toBeTruthy()
        expect(result.output).toContain(`artifact://${result.artifactId}`)
        expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThan(60_000)

        // readState 仍保存真实切片（800 行），不受 OutputSink 影响
        const absPath = join(TMP, 'huge.txt')
        const state = testReadState.get(absPath)
        expect(state).toBeDefined()
        expect(state!.content.split('\n').length).toBe(800)
      } finally {
        rmSyncOs(sessionsDir, { recursive: true, force: true })
      }
    })

    it('无 artifactStore 时大文件仍走 100KB/2000 行截断', async () => {
      const line = 'y'.repeat(199)
      const content = Array.from({ length: 800 }, () => line).join('\n')
      writeFileSync(join(TMP, 'huge-no-store.txt'), content)

      const result = await readTool.execute(
        { path: 'huge-no-store.txt' },
        createContext()
      )

      expect(result.success).toBe(true)
      expect(result.artifactId).toBeUndefined()
      expect(result.output).toContain('[显示')
      expect(result.output).not.toContain('artifact://')
    })
  })

  // ── 结构化摘要 ───────────────────────────────────────────

  describe('结构化摘要', () => {
    /** 生成大 TS 文件（约 2000 行） */
    function writeLargeTs(relativePath: string, fnCount: number, bodyLines = 20): string {
      const lines = [
        "import { x } from 'y'",
        '',
      ]
      for (let i = 0; i < fnCount; i++) {
        lines.push(`export function fn${i}(n: number): number {`)
        for (let j = 0; j < bodyLines; j++) {
          lines.push(`  const v${j} = n + ${i} + ${j}`)
        }
        lines.push(`  return v${bodyLines - 1}`)
        lines.push(`}`)
        lines.push('')
      }
      lines.push('export default fn0')
      const content = lines.join('\n')
      writeFileSync(join(TMP, relativePath), content)
      return content
    }

    it('2000 行 TS 文件走 structure-summary 且 tool result < 原文 15%', async () => {
      const original = writeLargeTs('summary.ts', 80, 20)
      const result = await readTool.execute({ path: 'summary.ts' }, createContext())

      expect(result.success).toBe(true)
      expect(result.output).toContain('[read mode: structure-summary]')
      expect(result.output).toContain('{folded}:')

      const body = stripWorkspaceHeader(result.output)
      const ratio = Buffer.byteLength(body, 'utf8') / Buffer.byteLength(original, 'utf8')
      expect(ratio).toBeLessThan(0.15)
    })

    it('带 offset/limit 时不走摘要', async () => {
      writeLargeTs('summary-paged.ts', 90)
      const result = await readTool.execute(
        { path: 'summary-paged.ts', offset: 0, limit: 10 },
        createContext()
      )
      expect(result.success).toBe(true)
      expect(result.output).not.toContain('[read mode: structure-summary]')
    })

    it('摘要模式下 readState 仍保存真实全文', async () => {
      const original = writeLargeTs('summary-state.ts', 90)
      await readTool.execute({ path: 'summary-state.ts' }, createContext())

      const absPath = join(TMP, 'summary-state.ts')
      const state = testReadState.get(absPath)
      expect(state).toBeDefined()
      expect(state!.content).toBe(original.replace(/\r\n/g, '\n'))
    })

    it('行数不足 MIN_SUMMARY_LINES 时不走摘要', async () => {
      writeFileSync(join(TMP, 'small.ts'), 'export const x = 1\n'.repeat(50))
      const result = await readTool.execute({ path: 'small.ts' }, createContext())
      expect(result.output).not.toContain('[read mode: structure-summary]')
      expect(result.output.split('\n').length).toBeLessThan(MIN_SUMMARY_LINES)
    })

    it('摘要后仍超 maxContextBytes 时落 artifact', async () => {
      const sessionsDir = mkdtempSync(join(tmpdir(), 'nova-read-summary-art-'))
      const sessionId = 'sess_summary_art'
      const store = new ArtifactStore(sessionsDir)

      // 大量 export 签名使摘要本身仍 > 50KB
      const lines = ['import { z } from "z"', '']
      for (let i = 0; i < 800; i++) {
        lines.push(`export function veryLongNamedFunction${i}(a: number, b: number, c: number): number {`)
        for (let j = 0; j < 8; j++) lines.push(`  const t${j} = a + b + c + ${j}`)
        lines.push(`  return t7`)
        lines.push(`}`)
        lines.push('')
      }
      writeFileSync(join(TMP, 'mega.ts'), lines.join('\n'))

      try {
        const result = await readTool.execute(
          { path: 'mega.ts' },
          createContext({ artifactStore: store, sessionId })
        )
        expect(result.success).toBe(true)
        expect(result.output).toContain('[read mode: structure-summary]')
        expect(result.artifactId).toBeTruthy()
        expect(result.output).toContain(`artifact://${result.artifactId}`)
      } finally {
        rmSyncOs(sessionsDir, { recursive: true, force: true })
      }
    })
  })
})
