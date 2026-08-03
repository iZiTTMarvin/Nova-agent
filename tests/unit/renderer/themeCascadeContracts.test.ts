import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainEntry = readFileSync(
  new URL('../../../src/renderer/main.tsx', import.meta.url),
  'utf8'
)
const parchmentCss = readFileSync(
  new URL('../../../src/renderer/styles/astryx-parchment.css', import.meta.url),
  'utf8'
)
const parchmentThemeSource = readFileSync(
  new URL('../../../src/renderer/styles/astryx-parchment-theme.ts', import.meta.url),
  'utf8'
)

describe('Astryx cascade 契约', () => {
  it('入口 CSS 顺序：reset → astryx.css → astryx-parchment.css → global.css', () => {
    const imports = [...mainEntry.matchAll(/import\s+'([^']+\.css)'/g)].map(m => m[1])
    const expected = [
      '@astryxdesign/core/reset.css',
      '@astryxdesign/core/astryx.css',
      './styles/astryx-parchment.css',
      './styles/global.css'
    ]
    expect(imports).toEqual(expected)
  })

  it('产物包含 reset 层与 astryx-theme 层（theme 必须在组件层之后）', () => {
    // core 的 astryx.css 是 @layer astryx-base；生成产物只有 reset + astryx-theme，
    // 二者通过入口 import 顺序保证 astryx-theme 在 astryx-base 之后声明。
    const resetIdx = parchmentCss.indexOf('@layer reset')
    const themeIdx = parchmentCss.indexOf('@layer astryx-theme')
    expect(resetIdx).toBeGreaterThanOrEqual(0)
    expect(themeIdx).toBeGreaterThan(resetIdx)
  })

  it('typography scale 生成字号 token（Astryx 是字号唯一权威）', () => {
    // base 14px → --font-size-base: 0.875rem；ratio 1.125 → 1.125rem 是 1rem 的 1.125 倍
    expect(parchmentCss).toMatch(/--font-size-base:\s*0\.875rem/)
    expect(parchmentCss).toMatch(/--font-size-lg:\s*1rem/)
    // 语义 token 引用原始档位
    expect(parchmentCss).toMatch(/--text-body-size:\s*var\(--font-size-base\)/)
  })

  it('theme 源声明了 type scale 与 radius（产品不另设根字号 hack）', () => {
    expect(parchmentThemeSource).toMatch(/scale:\s*\{\s*base:\s*14,\s*ratio:\s*1\.125\s*\}/)
    expect(parchmentThemeSource).toMatch(/radius:\s*\{[\s\S]*?base:\s*4,[\s\S]*?multiplier:\s*1\s*\}/)
  })
})
