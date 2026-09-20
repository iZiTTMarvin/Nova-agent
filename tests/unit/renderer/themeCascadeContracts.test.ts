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

const globalCss = readFileSync(
  new URL('../../../src/renderer/styles/global.css', import.meta.url),
  'utf8'
)

describe('主题 token 层契约', () => {
  it('global.css 把 data-theme 映射到 color-scheme，light-dark() 才有求值依据', () => {
    // nova 的整层 token 用 light-dark() 单份声明深浅取值，靠 color-scheme 决定取哪一支。
    // 该映射由 Astryx 生成产物提供，是承重前提，重建时丢了就必须被发现。
    expect(parchmentCss).toMatch(/:root\s*\{\s*color-scheme:\s*light dark;\s*\}/)
    expect(parchmentCss).toMatch(/html\[data-theme="dark"\]\s*\{\s*color-scheme:\s*dark;\s*\}/)
    expect(parchmentCss).toMatch(/html\[data-theme="light"\]\s*\{\s*color-scheme:\s*light;\s*\}/)
  })

  it('深浅色只声明一次，不再复制深色值块', () => {
    expect(globalCss).not.toMatch(/data-theme=['"]dark['"]/)
    expect(globalCss).not.toMatch(/prefers-color-scheme/)
    expect(globalCss.match(/:root\s*\{/g)).toHaveLength(1)
  })

  it('深色表面阶梯逐级变亮，且地板离开准纯黑', () => {
    // 越靠近观察者越亮；地板过暗会让黑色投影与叠加层全部失效（黑上叠黑）
    const tier = (name: string) => {
      const m = globalCss.match(new RegExp(`--surface-${name}:\\s*light-dark\\([^,]+,\\s*(#[0-9a-f]{6})\\)`))
      if (!m) throw new Error(`missing --surface-${name}`)
      const n = parseInt(m[1].slice(1), 16)
      const chan = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
        const v = c / 255
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      })
      return 116 * (0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2]) ** (1 / 3) - 16
    }
    const canvas = tier('canvas')
    const sidebar = tier('sidebar')
    const card = tier('card')
    expect(canvas).toBeGreaterThan(6)   // 不再是 #09090b 那样的准纯黑
    expect(sidebar - canvas).toBeGreaterThan(3.5)
    expect(card - sidebar).toBeGreaterThan(3.5)
  })

  it('阴影阶梯在深色下保留可见的抬升信号', () => {
    // 纯黑低 alpha 投影在深底上等于零，深色分支必须拉深 alpha 并附顶部受光边缘
    expect(globalCss).toMatch(/--shadow-popup:[\s\S]*?inset 0 1px 0 light-dark\(transparent, rgba\(255, 255, 255/)
    expect(globalCss).toMatch(/--shadow-card:[\s\S]*?inset 0 1px 0 light-dark\(transparent, rgba\(255, 255, 255/)
  })

  it('不残留已废弃的 token 名', () => {
    for (const dead of ['--bg-hover', '--bg-cream', '--border-light', '--border-chrome', '--surface-sidebar-hover']) {
      expect(globalCss).not.toContain(dead)
    }
  })
})
