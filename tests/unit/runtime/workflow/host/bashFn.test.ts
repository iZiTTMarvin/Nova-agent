import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createBashFn } from '../../../../../src/runtime/workflow/host/bashFn'
import { makeHostHarness } from './hostTestContext'

describe('host bashFn', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-host-bash-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('成功命令返回 exitCode 0 与 stdout', async () => {
    const bash = createBashFn(makeHostHarness(tmp).ctx)
    const result = await bash('echo nova-host')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('nova-host')
  })

  it('失败命令返回非零 exitCode 而不抛异常', async () => {
    const h = makeHostHarness(tmp)
    // 用脚本文件而非 -e：不同 shell 对引号处理不一致
    // 具体码值不断言：Windows PowerShell 会把子进程非零码统一折成 1
    writeFileSync(join(tmp, 'fail.cjs'), 'process.exit(7)\n', 'utf-8')
    const result = await createBashFn(h.ctx)('node fail.cjs')
    expect(result.exitCode).toBeGreaterThan(0)
  })

  it('scope 关闭后返回 exitCode -1，不执行命令', async () => {
    const h = makeHostHarness(tmp)
    const bash = createBashFn(h.ctx)
    await h.scope.close('cancelled')
    const result = await bash('echo should-not-run')
    expect(result).toEqual({ exitCode: -1, stdout: '', stderr: 'cancelled' })
  })

  it('cwd 越界时拒绝执行', async () => {
    const bash = createBashFn(makeHostHarness(tmp).ctx)
    const result = await bash('echo x', { cwd: join(tmp, '..') })
    expect(result.exitCode).toBe(-1)
    expect(result.stderr).toMatch(/越界|不存在/)
  })

  it('危险命令被权限层拒绝且不抛异常', async () => {
    const bash = createBashFn(makeHostHarness(tmp).ctx)
    // 取提权类样本：即使被误放行也不会破坏测试机器
    const result = await bash('sudo whoami')
    expect(result.exitCode).toBe(-1)
    expect(result.stdout).toBe('')
  })
})
