import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    ssr: resolve('src/runtime/code-graph/worker/codeGraphWorker.ts'),
    outDir: resolve('out/headless'),
    emptyOutDir: false,
    rollupOptions: {
      external: ['better-sqlite3'],
      output: {
        format: 'cjs',
        entryFileNames: 'codeGraphWorker.cjs',
        inlineDynamicImports: true
      }
    }
  },
  ssr: {
    noExternal: true,
    external: ['better-sqlite3']
  }
})
