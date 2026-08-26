import { describe, expect, it } from 'vitest'
import {
  MISSING_PERMISSION_MODE_ERROR,
  parseArgs,
  PERMISSION_MODE_CHOICES
} from '../../../src/headless/cliOptions'

describe('headless CLI 参数校验', () => {
  it('缺少 --permission-mode 时启动失败，错误信息列全三个可选值', () => {
    expect(() => parseArgs([])).toThrow(MISSING_PERMISSION_MODE_ERROR)
    try {
      parseArgs(['--workdir', process.cwd()])
      throw new Error('expected parseArgs to throw')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      for (const choice of PERMISSION_MODE_CHOICES) {
        expect(message).toContain(choice)
      }
      expect(message).toContain('必须显式指定 --permission-mode')
    }
  })

  it('非法权限模式被拒绝，合法值透传', () => {
    expect(() => parseArgs(['--permission-mode', 'ask'])).toThrow(/不支持的 --permission-mode/)
    expect(
      parseArgs(['--permission-mode', 'auto']).permissionMode
    ).toBe('auto')
    expect(
      parseArgs(['--permission-mode', 'full_access']).permissionMode
    ).toBe('full_access')
  })
})
