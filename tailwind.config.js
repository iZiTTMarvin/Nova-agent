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
        // 必须在此注册才会生成工具类，缺注册时类名静默失效（背景/边框丢失）
        'surface-canvas': 'var(--surface-canvas)',
        'surface-muted': 'var(--surface-muted)',
        'surface-sidebar-hover': 'var(--surface-sidebar-hover)',
        'border-subtle': 'var(--border-subtle)',
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
