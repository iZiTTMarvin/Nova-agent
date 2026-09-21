import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

describe('runtime BrowserPort 边界', () => {
  it('不导入 Electron', () => {
    const src = readFileSync(
      path.join(__dirname, '../../../../src/runtime/browser/index.ts'),
      'utf8'
    )
    expect(src).not.toMatch(/from\s+['"]electron(?:\/[^'"]*)?['"]/)
    expect(src).not.toMatch(/require\s*\(\s*['"]electron/)
  })
})
