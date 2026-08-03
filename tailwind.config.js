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
        'border-warm': 'var(--border-warm)',
        'text-primary': 'var(--text-primary)',
        'text-secondary': 'var(--text-secondary)',
        'text-muted': 'var(--text-muted)',
        'border-cream': 'var(--border-cream)',
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
