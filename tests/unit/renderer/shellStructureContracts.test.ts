import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(
  new URL('../../../src/renderer/App.tsx', import.meta.url),
  'utf8'
)
const sidebarSource = readFileSync(
  new URL('../../../src/renderer/components/Sidebar.tsx', import.meta.url),
  'utf8'
)
const appCss = readFileSync(
  new URL('../../../src/renderer/App.css', import.meta.url),
  'utf8'
)
const sidebarCss = readFileSync(
  new URL('../../../src/renderer/components/Sidebar.css', import.meta.url),
  'utf8'
)

describe('壳结构契约（AppShell + SideNav 权威）', () => {
  it('App 根布局由 AppShell 拥有：无贯穿 topNav，左右两栏各自通顶', () => {
    expect(appSource).toContain("from '@astryxdesign/core/AppShell'")
    expect(appSource).toMatch(/<AppShell[\s\S]*?sideNav=\{<Sidebar/)
    // 两栏通顶布局：AppShell 不再装 topNav；内容区顶行由 ContentTopBar 承担
    expect(appSource).not.toMatch(/topNav=/)
    expect(appSource).toMatch(/<ContentTopBar/)
  })

  it('手写壳类名已清零：不得再有 app-wrapper/app-layout/app-main 根结构', () => {
    expect(appSource).not.toMatch(/className="app-(?:wrapper|layout|main)"/)
    expect(appCss).not.toMatch(/\.app-(?:wrapper|layout|main|sidebar)/)
  })

  it('Sidebar 根结构由 SideNav 拥有：自有顶行 + topContent/footer 分区，无手写 aside 壳', () => {
    expect(sidebarSource).toContain("from '@astryxdesign/core/SideNav'")
    // 侧栏自己的顶行（品牌 + 折叠开关），兼作本栏窗口拖拽区
    expect(sidebarSource).toContain('sidebar-topbar')
    expect(sidebarSource).toMatch(/topContent=/)
    expect(sidebarSource).toMatch(/footer=/)
    expect(sidebarSource).not.toMatch(/<aside/)
  })

  it('侧栏会话行走 SideNavItem 选中态，不以自绘白卡片承载选中', () => {
    expect(sidebarSource).toMatch(/isSelected=\{isActive\}/)
    expect(sidebarSource).not.toMatch(/bg-white shadow-sm border border-border-warm/)
    expect(sidebarSource).not.toMatch(/from 'framer-motion'/)
    // 这些深入口在 Vite 预构建下会拉裂 React，侧栏禁用
    expect(sidebarSource).not.toContain("from '@astryxdesign/core/Kbd'")
    expect(sidebarSource).not.toContain("from '@astryxdesign/core/StatusDot'")
    expect(sidebarSource).not.toContain("from '@astryxdesign/core/MoreMenu'")
  })

  it('App.css 只保留 Tailwind 生成入口', () => {
    expect(appCss).toContain('@tailwind utilities;')
  })

  it('侧栏分隔线只有一个 Owner：AppShell 不画，.sidebar-shell 独占', () => {
    // variant="section" 会让 LayoutPanel 也画一条 borderInlineEnd，与 .sidebar-shell
    // 自带的 border-right 同 token 叠成 2px；且折叠时它无法随之消失，留下 1px 孤线。
    // "surface" 与 "section" 底色相同，仅少了那条分隔线。
    expect(appSource).toMatch(/variant="surface"/)
    expect(appSource).not.toMatch(/variant="section"/)

    const shellRule = sidebarCss.match(/\.sidebar-shell\s*\{([\s\S]*?)\}/)?.[1] ?? ''
    expect(shellRule).toMatch(/border-right:\s*1px solid var\(--border-subtle\)/)

    const collapsedRule = sidebarCss.match(/\.sidebar-shell--collapsed\s*\{([\s\S]*?)\}/)?.[1] ?? ''
    expect(collapsedRule).toMatch(/border-right:\s*none/)
  })
})
