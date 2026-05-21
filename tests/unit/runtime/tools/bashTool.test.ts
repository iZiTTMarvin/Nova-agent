import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { bashTool } from '../../../../src/runtime/tools/bashTool'
import type { ToolContext } from '../../../../src/runtime/tools/types'

const WORKSPACE = process.cwd()

function createContext(): ToolContext {
  return { workingDir: WORKSPACE }
}

function shellEscapePath(filePath: string): string {
  return `'${filePath.replace(/'/g, `'\\''`)}'`
}

describe('bashTool', () => {
  // ── 基础执行 ───────────────────────────────────────────

  it('执行简单命令并返回输出', async () => {
    const result = await bashTool.execute(
      { command: 'echo "hello world"' },
      createContext()
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('hello world')
  })

  it('执行多行输出命令', async () => {
    const result = await bashTool.execute(
      { command: 'echo "line1" && echo "line2"' },
      createContext()
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('line1')
    expect(result.output).toContain('line2')
  })

  it('命令执行失败时返回错误信息', async () => {
    const result = await bashTool.execute(
      { command: 'exit 1' },
      createContext()
    )
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('缺少 command 参数时返回错误', async () => {
    const result = await bashTool.execute({}, createContext())
    expect(result.success).toBe(false)
    expect(result.error).toContain('command')
  })

  // ── 工作目录 ───────────────────────────────────────────

  it('在工作目录下执行命令', async () => {
    const result = await bashTool.execute(
      { command: 'cd' },
      createContext()
    )
    expect(result.success).toBe(true)
    // Windows 下 cd 输出当前目录
    expect(result.output).toBeTruthy()
  })

  // ── 超时机制 ───────────────────────────────────────────

  it('超时后终止命令并返回错误', async () => {
    // 跨平台长运行命令：Windows 用 ping，Unix 用 sleep
    const longCmd = process.platform === 'win32'
      ? 'ping -n 30 127.0.0.1 >nul'
      : 'sleep 30'
    const result = await bashTool.execute(
      { command: longCmd, timeout: 1 },
      createContext()
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('超时')
  }, 15_000)

  // ── 安全边界 ───────────────────────────────────────────

  it('空命令返回错误', async () => {
    const result = await bashTool.execute(
      { command: '' },
      createContext()
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('command')
  })

  // ── 取消机制 ───────────────────────────────────────────

  it('abortSignal 触发时终止命令', async () => {
    const controller = new AbortController()
    const longCmd = process.platform === 'win32'
      ? 'ping -n 30 127.0.0.1 >nul'
      : 'sleep 30'

    // 启动命令后立即取消
    const promise = bashTool.execute(
      { command: longCmd },
      { workingDir: WORKSPACE, abortSignal: controller.signal }
    )
    // 给命令一点启动时间，然后取消
    await new Promise(r => setTimeout(r, 100))
    controller.abort()

    const result = await promise
    expect(result.success).toBe(false)
    expect(result.error).toContain('取消')
  }, 10_000)

  it('abortSignal 触发后不应留下继续运行的后台子进程', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'nova-agent-bash-abort-'))
    const markerPath = join(tempDir, 'marker.txt')
    const controller = new AbortController()

    const delayedWriteCommand = process.platform === 'win32'
      ? `powershell -NoProfile -Command "Start-Sleep -Seconds 2; Set-Content -Path '${markerPath.replace(/'/g, "''")}' -Value done"`
      : `sh -c "sleep 2; printf done > ${shellEscapePath(markerPath)}"`

    try {
      const promise = bashTool.execute(
        { command: delayedWriteCommand },
        { workingDir: WORKSPACE, abortSignal: controller.signal }
      )
      await new Promise(r => setTimeout(r, 100))
      controller.abort()

      const result = await promise
      await new Promise(r => setTimeout(r, 2500))

      expect(result.success).toBe(false)
      expect(result.error).toContain('取消')
      expect(existsSync(markerPath)).toBe(false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 12_000)

  // ── stderr 采集 ────────────────────────────────────────

  it('同时采集 stdout 和 stderr', async () => {
    const result = await bashTool.execute(
      { command: 'echo "out" && echo "err" >&2' },
      createContext()
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('out')
    expect(result.output).toContain('err')
  })

  // ── 参数校验 ───────────────────────────────────────────

  it('timeout 参数被正确识别（合法正整数）', async () => {
    const result = await bashTool.execute(
      { command: 'echo "fast"', timeout: 10 },
      createContext()
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('fast')
  })
})
