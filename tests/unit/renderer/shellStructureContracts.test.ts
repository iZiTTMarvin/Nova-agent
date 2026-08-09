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

describe('壳结构契约（AppShell + SideNav 权威）', () => {
  it('App 根布局由 AppShell 拥有：topNav/sideNav slot 装配 TitleBar 与 Sidebar', () => {
    expect(appSource).toContain("from '@astryxdesign/core/AppShell'")
    expect(appSource).toMatch(/<AppShell[\s\S]*?topNav=\{<TitleBar/)
    expect(appSource).toMatch(/<AppShell[\s\S]*?sideNav=\{<Sidebar/)
  })

  it('手写壳类名已清零：不得再有 app-wrapper/app-layout/app-main 根结构', () => {
    expect(appSource).not.toMatch(/className="app-(?:wrapper|layout|main)"/)
    expect(appCss).not.toMatch(/\.app-(?:wrapper|layout|main|sidebar)/)
  })

  it('Sidebar 根结构由 SideNav 拥有：header/topContent/footer 分区，无手写 aside 壳', () => {
    expect(sidebarSource).toContain("from '@astryxdesign/core/SideNav'")
    expect(sidebarSource).toMatch(/<SideNav[\s\S]*?header=/)
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
})
