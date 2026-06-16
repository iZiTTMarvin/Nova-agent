import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { bashTool } from '../../../../src/runtime/tools/bashTool'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import type { ToolContext } from '../../../../src/runtime/tools/types'
import { CheckpointManager } from '../../../../src/runtime/checkpoints/CheckpointManager'
import { ArtifactStore } from '../../../../src/runtime/artifacts/ArtifactStore'

const WORKSPACE = process.cwd()
const checkpointSpy = vi.spyOn(CheckpointManager.prototype, 'recordBashChange')

/** 测试用 readState：bash 不写入 readState，但 ToolContext 要求该字段（I1） */
function createContext(): ToolContext {
  return { workingDir: WORKSPACE, readState: createReadState() }
}

function shellEscapePath(filePath: string): string {
  return `'${filePath.replace(/'/g, `'\\''`)}'`
}

afterEach(() => {
  checkpointSpy.mockClear()
})

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
    // 毫秒精度：1000ms = 1s
    const result = await bashTool.execute(
      { command: longCmd, timeout: 1000 },
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
      { workingDir: WORKSPACE, readState: createReadState(), abortSignal: controller.signal }
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
        { workingDir: WORKSPACE, readState: createReadState(), abortSignal: controller.signal }
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
    // 跨 shell 写法：用 node 显式往两个流写
    // PowerShell 不支持 `>&2`，cmd 不支持 `$stderr`，统一走 node -e
    const cmd = process.platform === 'win32'
      ? 'node -e "process.stdout.write(\'out\\n\'); process.stderr.write(\'err\\n\');"'
      : 'node -e "process.stdout.write(\'out\\n\'); process.stderr.write(\'err\\n\');"'
    const result = await bashTool.execute(
      { command: cmd },
      createContext()
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('out')
    expect(result.output).toContain('err')
  })

  // ── 参数校验 ───────────────────────────────────────────

  it('timeout 参数被正确识别（毫秒）', async () => {
    // 毫秒精度：10000ms = 10s，echo 远远小于这个时间
    const result = await bashTool.execute(
      { command: 'echo "fast"', timeout: 10000 },
      createContext()
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('fast')
  })

  it('bash 改动文件时会把原始内容记录到 checkpoint', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'nova-agent-bash-checkpoint-'))
    const checkpointDir = join(tempDir, '.checkpoints')
    const manager = new CheckpointManager({
      checkpointDir,
      sessionId: 'sess_1',
      workspaceRoot: tempDir
    })
    manager.beginMessage('msg_1')

    const filePath = join(tempDir, 'big.txt')
    const originalContent = 'x'.repeat(120 * 1024)
    await import('fs/promises').then(fs => fs.writeFile(filePath, originalContent, 'utf8'))

    const mutateCommand = process.platform === 'win32'
      ? `powershell -NoProfile -Command "(Get-Content -Raw '${filePath.replace(/'/g, "''")}') + 'tail' | Set-Content '${filePath.replace(/'/g, "''")}'"`
      : `python - <<'PY'\nfrom pathlib import Path\npath = Path(${JSON.stringify(filePath)})\npath.write_text(path.read_text() + 'tail', encoding='utf-8')\nPY`

    try {
      const result = await bashTool.execute(
        { command: mutateCommand },
        { workingDir: tempDir, readState: createReadState(), checkpointManager: manager }
      )

      expect(result.success).toBe(true)
      // C2 修复后 recordBashChange 接收 Buffer 而非 string，避免 utf8 编码损坏二进制文件。
      // snapshot.ts 会跳过 >10MB 文件的 content（这里 120KB 仍会被完整拷贝），
      // 所以备份 Buffer 应等于原始内容。用 Buffer.from + equals 比对，不依赖字符串。
      expect(checkpointSpy).toHaveBeenCalledTimes(1)
      const [calledPath, calledContent, calledIsNew] = checkpointSpy.mock.calls[0]
      expect(calledPath).toBe(filePath)
      expect(calledIsNew).toBe(false)
      expect(Buffer.isBuffer(calledContent)).toBe(true)
      expect((calledContent as Buffer).equals(Buffer.from(originalContent, 'utf8'))).toBe(true)
    } finally {
      manager.endMessage()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  // ── workdir 参数（新） ────────────────────────────────

  it('workdir 参数：相对路径解析', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'nova-agent-bash-workdir-'))
    try {
      const subDir = join(tempDir, 'sub')
      const { mkdirSync } = await import('fs')
      mkdirSync(subDir, { recursive: true })
      // 跨 shell 写法：用 node -e 在子目录创建 marker
      const markerPath = join(subDir, 'marker.txt')
      const cmd = `node -e "require('fs').writeFileSync('marker.txt', 'ok')"`
      const result = await bashTool.execute(
        { command: cmd, workdir: 'sub' },
        { workingDir: tempDir, readState: createReadState() }
      )
      expect(result.success).toBe(true)
      expect(existsSync(markerPath)).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  // ── 退出码处理（新） ──────────────────────────────────

  it('退出码 0 → success=true', async () => {
    const result = await bashTool.execute(
      { command: 'node -e "process.exit(0)"' },
      createContext()
    )
    expect(result.success).toBe(true)
  })

  it('退出码 1 → success=false, error 含退出码', async () => {
    const result = await bashTool.execute(
      { command: 'node -e "process.exit(1)"' },
      createContext()
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('退出码')
  })

  // ── bashTool 描述（动态渲染） ────────────────────────

  it('bashTool.description 包含当前 shell 信息', () => {
    expect(bashTool.description).toBeTruthy()
    expect(bashTool.description.length).toBeGreaterThan(50)
  })

  // ── C5 回归：workdir 边界校验 ────────────────────────

  it('workdir 越界（绝对路径）被拒绝', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'nova-agent-bash-workdir-escape-'))
    try {
      const outside = process.platform === 'win32' ? 'C:\\Windows' : '/etc'
      const result = await bashTool.execute(
        { command: 'echo hi', workdir: outside },
        { workingDir: tempDir, readState: createReadState() }
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('逃逸')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('workdir 越界（.. 相对路径）被拒绝', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'nova-agent-bash-workdir-dotdot-'))
    try {
      const result = await bashTool.execute(
        { command: 'echo hi', workdir: '../../..' },
        { workingDir: tempDir, readState: createReadState() }
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('逃逸')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('workdir 合法子目录允许执行', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'nova-agent-bash-workdir-ok-'))
    try {
      const subDir = join(tempDir, 'sub')
      const { mkdirSync } = await import('fs')
      mkdirSync(subDir, { recursive: true })
      const result = await bashTool.execute(
        { command: 'node -e "process.exit(0)"', workdir: 'sub' },
        { workingDir: tempDir, readState: createReadState() }
      )
      expect(result.success).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('200KB 大输出：有 artifactStore 时生成 artifactId 且上下文受控', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'nova-bash-artifact-'))
    const sessionId = 'sess_big_bash'
    const store = new ArtifactStore(sessionsDir)
    const sizeKb = 200
    const repeatCmd = process.platform === 'win32'
      ? `node -e "process.stdout.write('X'.repeat(${sizeKb * 1024}))"`
      : `node -e "process.stdout.write('X'.repeat(${sizeKb * 1024}))"`

    try {
      const result = await bashTool.execute(
        { command: repeatCmd },
        {
          workingDir: WORKSPACE,
          readState: createReadState(),
          artifactStore: store,
          sessionId
        }
      )

      expect(result.success).toBe(true)
      expect(result.artifactId).toBeTruthy()
      expect(result.output).toContain(`artifact://${result.artifactId}`)
      expect(result.output).not.toContain('[Full output saved to:')

      const full = await store.read(sessionId, result.artifactId!)
      expect(full.length).toBe(sizeKb * 1024)

      const artifactPath = store.resolvePath(sessionId, result.artifactId!)
      expect(existsSync(artifactPath)).toBe(true)
      // 模型上下文应远小于全文（200KB ≈ 50K+ tokens；截断后应 < 15K tokens 量级）
      expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThan(60_000)
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('无 artifactStore 时大输出仍使用 [Full output saved to: ...] 兜底', async () => {
    const repeatCmd = `node -e "process.stdout.write('Y'.repeat(60000))"`
    const result = await bashTool.execute(
      { command: repeatCmd },
      createContext()
    )
    expect(result.output).toContain('[Full output saved to:')
    expect(result.artifactId).toBeUndefined()
  }, 20_000)
})
