import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { cpSync, existsSync } from 'fs'
import { resolve } from 'path'
import type { Plugin } from 'vite'

/** 构建时将 .nova/skills 复制到 out/main，供 app.getAppPath()/.nova/skills 读取 */
function copyNovaBuiltinSkills(): Plugin {
  return {
    name: 'copy-nova-builtin-skills',
    closeBundle() {
      const src = resolve('.nova/skills')
      const dest = resolve('out/main/.nova/skills')
      if (existsSync(src)) {
        cpSync(src, dest, { recursive: true })
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyNovaBuiltinSkills()],
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@shared': resolve('src/shared'),
        '@runtime': resolve('src/runtime')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()],
    server: {
      host: '127.0.0.1'
    }
  }
})
