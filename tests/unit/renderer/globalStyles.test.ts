import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const globalStyles = readFileSync(
  new URL('../../../src/renderer/styles/global.css', import.meta.url),
  'utf8'
)
const appStyles = readFileSync(
  new URL('../../../src/renderer/App.css', import.meta.url),
  'utf8'
)

interface TailwindConfigContract {
  corePlugins?: {
    preflight?: boolean
    utilities?: boolean
  }
}

const require = createRequire(import.meta.url)
const tailwindConfig = require('../../../tailwind.config.js') as TailwindConfigContract

describe('全局样式 reset 边界', () => {
  it('不会以 unlayered universal reset 覆盖 Astryx 的 margin/padding', () => {
    const universalReset = globalStyles.match(
      /\*,\s*\*::before,\s*\*::after\s*\{([\s\S]*?)\}/
    )?.[1]

    expect(universalReset).toBeDefined()
    expect(universalReset).not.toMatch(/\b(?:margin|padding)\s*:/)
    expect(universalReset).toMatch(/\bbox-sizing\s*:\s*border-box\s*;/)
  })

  it('禁用 Tailwind preflight，同时保留 utilities 生成入口', () => {
    expect(tailwindConfig.corePlugins?.preflight).toBe(false)
    expect(tailwindConfig.corePlugins?.utilities).not.toBe(false)
    expect(appStyles).toContain('@tailwind utilities;')
  })
})
