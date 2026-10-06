import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() }
}))

import { resolveAppIconPath } from '../../../src/main/appIcon'

describe('开发态窗口图标', () => {
  it('Windows 使用同步生成的原生 ICO', () => {
    if (process.platform !== 'win32') return
    expect(resolveAppIconPath()).toMatch(/[\\/]build[\\/]icon\.ico$/)
  })
})
