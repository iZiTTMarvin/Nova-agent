/**
 * Astryx 羊皮纸主题
 *
 * 基于项目现有 CSS 变量（见 styles/global.css）扩展自 neutralTheme，
 * 让 Astryx 原子组件在视觉上融入 Nova 的暖色拟纸风格。
 *
 * 权威方向：
 * - 颜色（中性色/表面/边框/状态）→ 由 Nova 变量桥接（多套可切换色板）
 * - 排版（字号/行高/字重）→ 由 typography.scale 决定（Astryx 是唯一权威）
 * - 圆角/过渡 → 由 radius/motion 配置生成 token（全局 --radius-* 走此）
 * - 组件级覆盖 → components hook（禁在页面 CSS 硬盖 .astryx-*）
 */
import { defineTheme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral'
import { neutralIconRegistry } from '@astryxdesign/theme-neutral'

export const parchmentTheme = defineTheme({
  name: 'parchment',
  extends: neutralTheme,
  typography: {
    // 几何级数 type scale：base 14px、ratio 1.125。
    // 对标 Cursor / Claude Code / Codex 的紧凑正文密度。
    // 生成 --font-size-*（11 档）与 --text-* 语义 token，
    // 并成为产品字号/行高的唯一权威（全局 CSS 硬编码字号将逐步收敛）。
    scale: { base: 14, ratio: 1.125 }
  },
  radius: {
    // 生成 --radius-* token；保持 Astryx 默认 multiplier=1（base 4px）。
    // Nova 侧 --radius-sm/md/lg/xl 为业务自用，与 Astryx token 并存但
    // 组件几何一律走 Astryx token，不再手工覆盖。
    base: 4,
    multiplier: 1
  },
  icons: {
    // 显式声明图标注册表，防止 theme build 产物丢失图标。
    // 全量继承 neutralIconRegistry（lucide 语义图标 25 个）。
    ...neutralIconRegistry
  },
  tokens: {
    // ── 字体 ──
    '--font-family-body': 'var(--font-sans)',
    '--font-family-heading': 'var(--font-sans)',
    '--font-family-code': 'var(--font-mono)',

    // ── 语法高亮底（与 Markdown 围栏代码块暖色面一致）──
    '--color-syntax-background': 'var(--code-block-bg)',

    // ── 背景 ──
    '--color-background-surface': 'var(--bg-app)',
    '--color-background-body': 'var(--bg-app)',
    '--color-background-card': 'var(--bg-card)',
    '--color-background-popover': 'var(--bg-card)',
    '--color-background-muted': 'var(--bg-sand)',

    // ── 文本 ──
    '--color-text-primary': 'var(--text-primary)',
    '--color-text-secondary': 'var(--text-secondary)',
    '--color-text-disabled': 'var(--text-muted)',
    '--color-text-accent': 'var(--color-brand)',

    // ── 图标 ──
    '--color-icon-primary': 'var(--text-primary)',
    '--color-icon-secondary': 'var(--text-secondary)',
    '--color-icon-disabled': 'var(--text-muted)',
    '--color-icon-accent': 'var(--color-brand)',

    // ── 边框 ──
    '--color-border': 'var(--border-warm)',
    '--color-border-emphasized': 'var(--border-cream)',

    // ── 强调 / 状态色 ──
    '--color-accent': 'var(--color-brand)',
    '--color-accent-muted': 'var(--color-brand-dim)',
    // Keep status colors in Nova-owned variables so light/dark mode can swap
    // them without a self-referential Astryx token declaration.
    '--color-success': 'var(--nova-status-success)',
    '--color-error': 'var(--nova-status-error)',
    '--color-warning': '#d97757',
    '--color-success-muted': 'rgba(120, 140, 93, 0.12)',
    '--color-error-muted': 'rgba(181, 51, 51, 0.06)',
    '--color-warning-muted': 'rgba(217, 119, 87, 0.10)',

    // ── 前景在强调色上的反色 ──
    '--color-on-accent': '#ffffff',
    '--color-on-success': '#ffffff',
    '--color-on-error': '#ffffff',
    '--color-on-warning': '#ffffff',
    '--color-on-dark': '#ffffff',
    '--color-on-light': 'var(--text-primary)',

    // ── 覆盖层 / 悬停态 ──
    '--color-overlay': 'rgba(20, 20, 19, 0.45)',
    '--color-overlay-hover': 'rgba(20, 20, 19, 0.05)',
    '--color-overlay-pressed': 'rgba(20, 20, 19, 0.10)',
    '--color-tint-hover': 'var(--color-brand-dim)',

    // ── 骨架与阴影 ──
    '--color-skeleton': 'var(--bg-sand)',
    '--color-shadow': 'rgba(20, 20, 19, 0.10)',

    // ── 聊天气泡几何 ──
    // Astryx 默认 --radius-chat = base×7 = 28px（偏圆润的移动端风格）；
    // Nova 卡片语言在 8–16px，收敛到 16px 保持同一设计系统的圆角节奏。
    '--radius-chat': '16px'
  },
  components: {
    /* 用户气泡品牌表达：沙色底 + 暖边框 + 收尾角（sender 侧小圆角），
       宽度上限保留 Nova 既有 640px 阅读宽度。
       其余几何（padding/圆角基线/max(80%,280px) 下限）由 ChatMessageBubble 拥有。 */
    'chat-message-bubble': {
      'sender:user': {
        maxWidth: 'min(80%, 640px)',
        backgroundColor: 'var(--bg-sand)',
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: 'var(--border-warm)',
        borderEndEndRadius: 'var(--radius-inner)'
      }
    }
  }
})
