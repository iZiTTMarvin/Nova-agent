import { cpSync, existsSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, type Plugin } from 'vite'
import { copyCodeGraphAssets } from './scripts/build/codeGraphAssets'

function copyAgentPrompts(): Plugin {
  return {
    name: 'copy-headless-agent-prompts',
    closeBundle() {
      const source = resolve('src/runtime/agent/prompts')
      const destination = resolve('out/headless/prompts')
      if (existsSync(source)) cpSync(source, destination, { recursive: true })
    }
  }
}

export default defineConfig({
  plugins: [copyAgentPrompts(), copyCodeGraphAssets('out/headless')],
  build: {
    ssr: resolve('src/headless/cli.ts'),
    outDir: resolve('out/headless'),
    emptyOutDir: true,
    rollupOptions: {
      external: ['sharp', 'better-sqlite3'],
      output: {
        format: 'cjs',
        entryFileNames: 'nova-headless.cjs',
        // 索引依赖保留为独立 chunk，默认关闭时不会加载原生 SQLite。
        chunkFileNames: 'chunks/[name]-[hash].cjs'
      }
    }
  },
  ssr: {
    noExternal: true,
    external: ['sharp', 'better-sqlite3']
  }
})
