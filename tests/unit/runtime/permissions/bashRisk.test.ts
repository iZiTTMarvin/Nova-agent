import { describe, expect, it } from 'vitest'
import { assessCommandRisk } from '../../../../src/runtime/permissions/risk/bashRisk'

describe('shell 命令风险', () => {
  it.each(['pwsh', 'powershell'])('识别 %s 的反引号是转义字符', shell => {
    expect(assessCommandRisk('Write-Output "first`nsecond`nthird"', shell).isDangerous).toBe(false)
  })

  it.each(['bash', 'zsh', 'sh', 'custom'])('保留 %s 的反引号命令替换确认', shell => {
    expect(assessCommandRisk('echo `whoami`', shell).isDangerous).toBe(true)
  })

  it('PowerShell 调用 POSIX shell 时仍检查反引号', () => {
    expect(assessCommandRisk("bash -c 'echo `whoami`'", 'pwsh').isDangerous).toBe(true)
  })

  it('PowerShell 转义不能掩盖高风险命令', () => {
    expect(assessCommandRisk('Remove-`Item .\\temp -Recurse -Force', 'pwsh').isDangerous).toBe(true)
  })
})
