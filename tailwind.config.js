/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/renderer/index.html",
    "./src/renderer/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'bg-app': 'var(--bg-app)',
        'bg-card': 'var(--bg-card)',
        'border-warm': 'var(--border-warm)',
        'text-primary': 'var(--text-primary)',
        'text-secondary': 'var(--text-secondary)',
        'text-muted': 'var(--text-muted)',
        'border-cream': 'var(--border-cream)',
        // 设计令牌桥接：组件类名（bg-surface-* / border-border-* / text-text-* 等）
        // 必须在此注册才会生成工具类，缺注册时类名静默失效（背景/边框丢失）。
        // global.css 里的每个颜色令牌都要在这里登记，避免调用方被迫写 bg-[var(--..)] 任意值。
        'surface-canvas': 'var(--surface-canvas)',
        'surface-sidebar': 'var(--surface-sidebar)',
        'surface-sidebar-active': 'var(--surface-sidebar-active)',
        'surface-card': 'var(--surface-card)',
        'surface-muted': 'var(--surface-muted)',
        'surface-input': 'var(--surface-input)',
        'surface-hover': 'var(--surface-hover)',
        'surface-gutter': 'var(--surface-gutter)',
        'surface-danger': 'var(--surface-danger)',
        'surface-danger-subtle': 'var(--surface-danger-subtle)',
        'surface-warning': 'var(--surface-warning)',
        'surface-brand': 'var(--surface-brand)',
        'border-danger': 'var(--border-danger)',
        'border-brand': 'var(--border-brand)',
        'border-subtle': 'var(--border-subtle)',
        'border-item': 'var(--border-item)',
        'border-strong': 'var(--border-strong)',
        'text-placeholder': 'var(--text-placeholder)',
        'accent-primary': 'var(--accent-primary)',
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        serif: ['var(--font-serif)'],
      }
    },
  },
  // Astryx reset.css owns the document/form reset. Keeping Tailwind's
  // utilities while disabling preflight prevents an unlayered reset from
  // overriding Astryx component tokens and StyleX rules.
  corePlugins: {
    preflight: false,
  },
  plugins: [],
}
