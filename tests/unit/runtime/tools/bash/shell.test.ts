/**
 * shell.ts 单元测试
 *
 * 覆盖：Shell 发现 / 环境注入 / 自定义 shell 路径 / killProcessTree（Unix only）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { getShellConfig, getShellEnv, killProcessTree } from '@runtime/tools/bash/shell'

describe('shell', () => {
  describe('getShellConfig', () => {
    it('在当前平台返回一个有效 ShellConfig', () => {
      const config = getShellConfig()
      expect(config.shell).toBeTruthy()
      expect(Array.isArray(config.args)).toBe(true)
      expect(config.name).toBeTruthy()
      // shell 路径应存在（除自定义场景外）
      if (!config.shell.includes('not-exists')) {
        expect(existsSync(config.shell) || config.shell === '/bin/zsh' || config.shell === '/bin/bash' || config.shell === '/bin/sh').toBeTruthy()
      }
    })

    it('指定 customShellPath 覆盖默认发现', () => {
      if (process.platform === 'win32') {
        const customPath = process.env['SystemRoot'] + '/System32/cmd.exe'
        if (existsSync(customPath)) {
          const config = getShellConfig(customPath)
          expect(config.shell).toBe(customPath)
          expect(config.name).toBe('cmd')
        }
      } else {
        const config = getShellConfig('/bin/sh')
        expect(config.shell).toBe('/bin/sh')
        expect(config.name).toBe('bash')
      }
    })

    it('不存在的 customShellPath 抛错', () => {
      expect(() => getShellConfig('/path/does/not/exist')).toThrow(/不存在/)
    })
  })

  describe('getShellEnv', () => {
    it('空 binDirs 时返回 process.env 的副本', () => {
      const env = getShellEnv()
      expect(env.PATH ?? env.Path).toBeTruthy()
    })

    it('把绝对路径 binDir 加到 PATH 前面', () => {
      const dir = mkdtempSync(join(tmpdir(), 'bash-test-bin-'))
      try {
        const env = getShellEnv([dir])
        const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
        const firstSeg = (env[pathKey] ?? '').split(process.platform === 'win32' ? ';' : ':')[0]
        // 第一个 PATH 段应该包含我们注入的目录（大小写不敏感）
        expect(firstSeg.toLowerCase()).toBe(dir.toLowerCase())
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('相对路径的 binDir 被忽略', () => {
      const env = getShellEnv(['relative/path'])
      // 相对路径不会出现在 PATH 最前面
      const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
      const firstSeg = (env[pathKey] ?? '').split(process.platform === 'win32' ? ';' : ':')[0]
      expect(firstSeg.toLowerCase()).not.toBe('relative/path')
    })
  })

  // 进程终止测试在 Windows 上跑 taskkill，需要 child 进程存在
  describe('killProcessTree', () => {
    if (process.platform === 'win32') {
      it('Windows：调用 taskkill 不抛错', async () => {
        // 起一个 ping 子进程，然后 kill
        const child = spawn('ping', ['-n', '30', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' })
        const pid = child.pid
        expect(pid).toBeTruthy()
        await killProcessTree(pid)
        // 杀完不要求做额外断言——只要不抛异常即可
      })
    } else {
      it('Unix：SIGTERM→SIGKILL 渐进式终止', async () => {
        // 起一个 sleep 子进程
        const child = spawn('sleep', ['30'], { stdio: 'ignore' })
        const pid = child.pid
        expect(pid).toBeTruthy()
        const t0 = Date.now()
        await killProcessTree(pid)
        const dt = Date.now() - t0
        // 渐进式：3 秒等待 + 一点点执行时间
        expect(dt).toBeGreaterThanOrEqual(2900)
        // 确保进程真的死了
        try {
          process.kill(pid, 0)
          throw new Error('进程应该已经退出')
        } catch (err) {
          // ESRCH = 进程不存在，预期结果
          expect((err as NodeJS.ErrnoException).code).toBe('ESRCH')
        }
      })
    }
  })
})
