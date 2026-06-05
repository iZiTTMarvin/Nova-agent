/**
 * prompt.ts 单元测试
 *
 * 覆盖：三种 shell 家族（bash / pwsh / cmd）渲染出不同描述
 */
import { describe, it, expect } from 'vitest'
import { renderBashDescription } from '@runtime/tools/bash/prompt'

describe('renderBashDescription', () => {
  it('bash/zsh/sh 渲染为 bash 家族描述', () => {
    const text = renderBashDescription('bash', 'linux')
    expect(text).toContain('POSIX shell')
    expect(text).toContain('Linux')
    expect(text).toContain('workdir')
  })

  it('pwsh 渲染为 PowerShell 家族描述', () => {
    const text = renderBashDescription('pwsh', 'win32')
    expect(text).toContain('PowerShell')
    expect(text).toContain('Windows')
    // 不应出现 POSIX 专属提示
    expect(text).not.toContain('POSIX shell')
  })

  it('powershell 渲染为 PowerShell 家族描述', () => {
    const text = renderBashDescription('powershell', 'win32')
    expect(text).toContain('PowerShell')
  })

  it('cmd 渲染为 cmd 家族描述', () => {
    const text = renderBashDescription('cmd', 'win32')
    expect(text).toContain('cmd.exe')
    expect(text).toContain('Windows')
  })

  it('macOS 描述包含 macOS', () => {
    const text = renderBashDescription('zsh', 'darwin')
    expect(text).toContain('macOS')
  })

  it('描述里包含截断阈值与文件路径提示', () => {
    const text = renderBashDescription('bash', 'linux')
    expect(text).toContain('nova-bash-')
    expect(text).toContain('2000')
    expect(text).toContain('50KB')
  })

  it('描述里包含工具偏好（Glob / Grep 替代 find / grep）', () => {
    const text = renderBashDescription('bash', 'linux')
    expect(text).toContain('Glob')
    expect(text).toContain('Grep')
  })

  it('三种 shell 生成的描述互不相同', () => {
    const bash = renderBashDescription('bash', 'linux')
    const pwsh = renderBashDescription('pwsh', 'win32')
    const cmd = renderBashDescription('cmd', 'win32')
    expect(bash).not.toBe(pwsh)
    expect(pwsh).not.toBe(cmd)
    expect(bash).not.toBe(cmd)
  })
})
