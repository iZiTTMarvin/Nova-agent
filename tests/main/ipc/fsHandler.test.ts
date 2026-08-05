import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { readFileSync } from 'fs'

const mockIpcHandle = vi.fn()
const mockGetState = vi.fn(() => ({ currentProjectPath: null as string | null }))

vi.mock('electron', () => ({
  ipcMain: { handle: (...args: unknown[]) => mockIpcHandle(...args) },
  dialog: {},
  BrowserWindow: class {},
  app: { getPath: () => os.tmpdir() }
}))

vi.mock('../../../src/main/mainWindowRef', () => ({
  getMainWindow: () => null
}))

vi.mock('../../../src/main/logger', () => ({
  mainLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
}))

vi.mock('../../../src/main/services/WorkspaceService', () => ({
  getWorkspaceService: () => ({ getState: () => mockGetState() })
}))

import {
  listDirectoryEntries,
  readFilePreview,
  registerFsHandler,
  resolvePathInsideRoot
} from '../../../src/main/ipc/fsHandler'
import { FS_LIST_DIRECTORY, FS_READ_FILE_PREVIEW } from '../../../src/shared/ipc/channels'

describe('fsHandler 源码契约', () => {
  it('注册路径使用静态 import，禁止打包后失效的 require("./secureIpc")', () => {
    const src = readFileSync(
      path.join(__dirname, '../../../src/main/ipc/fsHandler.ts'),
      'utf8'
    )
    expect(src).toMatch(/import\s*\{\s*handle\s*\}\s*from\s*['"]\.\/secureIpc['"]/)
    expect(src).not.toMatch(/require\s*\(\s*['"]\.\/secureIpc['"]\s*\)/)
    expect(src).not.toMatch(/require\s*\(\s*['"]\.\.\/services\/WorkspaceService['"]\s*\)/)
  })
})

describe('fsHandler 注册', () => {
  beforeEach(() => {
    mockIpcHandle.mockClear()
    mockGetState.mockReset()
    mockGetState.mockReturnValue({ currentProjectPath: null })
  })

  it('registerFsHandler 以静态 channel 注册两个 handler，不抛模块解析错误', () => {
    expect(() => registerFsHandler()).not.toThrow()
    const channels = mockIpcHandle.mock.calls.map((c) => c[0])
    expect(channels).toEqual(expect.arrayContaining([FS_LIST_DIRECTORY, FS_READ_FILE_PREVIEW]))
  })
})

describe('fsHandler 纯函数', () => {
  let tmpRoot: string
  let outsideDir: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-fs-root-'))
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-fs-out-'))
    fs.mkdirSync(path.join(tmpRoot, 'src'))
    fs.mkdirSync(path.join(tmpRoot, 'docs'))
    fs.writeFileSync(path.join(tmpRoot, 'README.md'), '# hello\n', 'utf8')
    fs.writeFileSync(path.join(tmpRoot, 'src', 'a.ts'), ' const x = 1\n', 'utf8')
    fs.writeFileSync(path.join(tmpRoot, 'zebra.txt'), 'z\n', 'utf8')
    // 排除名单目录（应被过滤）
    for (const name of ['node_modules', '.git', 'dist', 'out', 'build', '.next', 'coverage', '__pycache__']) {
      fs.mkdirSync(path.join(tmpRoot, name))
      fs.writeFileSync(path.join(tmpRoot, name, 'secret.txt'), 'nope', 'utf8')
    }
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    fs.rmSync(outsideDir, { recursive: true, force: true })
  })

  it('单层列举：目录在前、名称排序、排除名单生效', () => {
    const { entries } = listDirectoryEntries(tmpRoot, '')
    const names = entries.map((e) => e.name)
    expect(names).toEqual(['docs', 'src', 'README.md', 'zebra.txt'])
    expect(entries.filter((e) => e.type === 'directory').map((e) => e.name)).toEqual(['docs', 'src'])
    expect(entries.every((e) => !e.relativePath.includes('\\'))).toBe(true)
    expect(entries.find((e) => e.name === 'src')?.relativePath).toBe('src')
  })

  it('子目录列举使用 POSIX relativePath', () => {
    const { entries } = listDirectoryEntries(tmpRoot, 'src')
    expect(entries).toEqual([{ name: 'a.ts', relativePath: 'src/a.ts', type: 'file' }])
  })

  it('拒绝 .. 逃逸与绝对路径注入', () => {
    expect(() => listDirectoryEntries(tmpRoot, '..')).toThrow(/逃逸|非法/)
    expect(() => listDirectoryEntries(tmpRoot, '../')).toThrow(/逃逸|非法/)
    expect(() => readFilePreview(tmpRoot, '../README.md')).toThrow(/逃逸|非法/)
    expect(() => resolvePathInsideRoot(tmpRoot, path.resolve(outsideDir, 'x'))).toThrow(/绝对|非法/)
    if (process.platform === 'win32') {
      expect(() => resolvePathInsideRoot(tmpRoot, 'C:\\Windows\\System32')).toThrow(/绝对|非法/)
    } else {
      expect(() => resolvePathInsideRoot(tmpRoot, '/etc/passwd')).toThrow(/绝对|非法/)
    }
  })

  it('符号链接指向 root 外时列表跳过；读预览拒绝', () => {
    const outsideFile = path.join(outsideDir, 'secret.txt')
    fs.writeFileSync(outsideFile, 'secret', 'utf8')
    const linkPath = path.join(tmpRoot, 'leak')
    try {
      fs.symlinkSync(outsideFile, linkPath)
    } catch {
      // Windows 无特权时无法创建 symlink
      return
    }
    const { entries } = listDirectoryEntries(tmpRoot, '')
    expect(entries.find((e) => e.name === 'leak')).toBeUndefined()
    expect(() => readFilePreview(tmpRoot, 'leak')).toThrow(/超出项目根|非法/)
  })

  it('预览截断：超过 512KB 只返回前缀', () => {
    const bigPath = path.join(tmpRoot, 'big.bin')
    const size = 512 * 1024 + 100
    const fd = fs.openSync(bigPath, 'w')
    try {
      fs.writeSync(fd, Buffer.alloc(size, 0x61)) // 'a'
    } finally {
      fs.closeSync(fd)
    }
    const result = readFilePreview(tmpRoot, 'big.bin')
    expect(result.binary).toBe(false)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.content, 'utf8')).toBe(512 * 1024)
  })

  it('二进制识别：前 8KB 含 NUL 返回 binary', () => {
    const binPath = path.join(tmpRoot, 'photo.bin')
    const buf = Buffer.alloc(100, 0x41)
    buf[10] = 0
    fs.writeFileSync(binPath, buf)
    const result = readFilePreview(tmpRoot, 'photo.bin')
    expect(result).toEqual({ content: '', truncated: false, binary: true })
  })

  it('正常文本预览', () => {
    const result = readFilePreview(tmpRoot, 'README.md')
    expect(result.binary).toBe(false)
    expect(result.truncated).toBe(false)
    expect(result.content).toContain('# hello')
  })
})
