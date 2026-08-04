import { cpSync, existsSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, type Plugin } from 'vite'

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
  plugins: [copyAgentPrompts()],
  build: {
    ssr: resolve('src/headless/cli.ts'),
    outDir: resolve('out/headless'),
    emptyOutDir: true,
    rollupOptions: {
      external: ['sharp'],
      output: {
        format: 'cjs',
        entryFileNames: 'nova-headless.cjs'
      }
    }
  },
  ssr: {
    noExternal: true,
    external: ['sharp']
  }
})
