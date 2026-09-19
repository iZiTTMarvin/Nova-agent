/**
 * Astryx 主题桥接定义（对标 Cline 现代桌面视觉系统）
 *
 * 将 Astryx 语义 Token 桥接至 Nova 的冷白灰 Zinc 变量体系，
 * 彻底消除暖黄羊皮纸与衬线体，保持无衬线现代阶梯。
 */
import { defineTheme } from '@astryxdesign/core/theme'
import { neutralTheme, neutralIconRegistry } from '@astryxdesign/theme-neutral'

export const parchmentTheme = defineTheme({
  name: 'parchment',
  extends: neutralTheme,
  typography: {
    scale: { base: 14, ratio: 1.125 }
  },
  radius: {
    base: 4,
    multiplier: 1
  },
  icons: {
    ...neutralIconRegistry
  },
  tokens: {
    // ── 字体 ──
    '--font-family-body': 'var(--font-sans)',
    '--font-family-heading': 'var(--font-sans)',
    '--font-family-code': 'var(--font-mono)',

    // ── 语法高亮底 ──
    '--color-syntax-background': 'var(--code-block-bg)',

    // ── 背景 ──
    '--color-background-surface': 'var(--surface-canvas)',
    '--color-background-body': 'var(--surface-canvas)',
    '--color-background-card': 'var(--surface-card)',
    '--color-background-popover': 'var(--surface-card)',
    '--color-background-muted': 'var(--surface-muted)',

    // ── 文本 ──
    '--color-text-primary': 'var(--text-primary)',
    '--color-text-secondary': 'var(--text-secondary)',
    '--color-text-disabled': 'var(--text-muted)',
    '--color-text-accent': 'var(--accent-primary)',

    // ── 图标 ──
    '--color-icon-primary': 'var(--text-primary)',
    '--color-icon-secondary': 'var(--text-secondary)',
    '--color-icon-disabled': 'var(--text-muted)',
    '--color-icon-accent': 'var(--accent-primary)',

    // ── 边框 ──
    '--color-border': 'var(--border-subtle)',
    '--color-border-emphasized': 'var(--border-strong)',

    // ── 强调 / 状态色 ──
    '--color-accent': 'var(--accent-primary)',
    '--color-accent-muted': 'rgba(59, 130, 246, 0.10)',
    '--color-success': 'var(--nova-status-success)',
    '--color-error': 'var(--nova-status-error)',
    '--color-warning': 'var(--accent-warning)',
    '--color-success-muted': 'rgba(34, 197, 94, 0.12)',
    '--color-error-muted': 'rgba(239, 68, 68, 0.08)',
    '--color-warning-muted': 'rgba(245, 158, 11, 0.12)',

    // ── 前景在强调色上的反色 ──
    '--color-on-accent': '#ffffff',
    '--color-on-success': '#ffffff',
    '--color-on-error': '#ffffff',
    '--color-on-warning': '#ffffff',
    '--color-on-dark': '#ffffff',
    '--color-on-light': 'var(--text-primary)',

    // ── 覆盖层 / 悬停态 ──
    '--color-overlay': 'rgba(0, 0, 0, 0.45)',
    '--color-overlay-hover': 'rgba(0, 0, 0, 0.04)',
    '--color-overlay-pressed': 'rgba(0, 0, 0, 0.08)',
    '--color-tint-hover': 'rgba(59, 130, 246, 0.08)',

    // ── 骨架与阴影 ──
    '--color-skeleton': 'var(--surface-muted)',
    '--color-shadow': 'rgba(0, 0, 0, 0.08)',

    // ── 聊天气泡几何 ──
    '--radius-chat': '16px'
  },
  components: {
    'chat-message-bubble': {
      'sender:user': {
        maxWidth: 'min(80%, 640px)',
        backgroundColor: 'var(--surface-muted)',
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: 'var(--border-subtle)',
        borderEndEndRadius: 'var(--radius-inner)'
      }
    }
  }
})

export const clineTheme = parchmentTheme
