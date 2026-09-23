import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { cpSync, existsSync } from 'fs'
import { resolve } from 'path'
import type { Plugin } from 'vite'
import { copyCodeGraphAssets } from './scripts/build/codeGraphAssets'

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

/** 构建时将 agent prompt 模板复制到 out/main/prompts，供 promptRenderer 按 __dirname 读取 */
function copyAgentPrompts(): Plugin {
  return {
    name: 'copy-agent-prompts',
    closeBundle() {
      const src = resolve('src/runtime/agent/prompts')
      const dest = resolve('out/main/prompts')
      if (existsSync(src)) {
        cpSync(src, dest, { recursive: true })
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      copyNovaBuiltinSkills(),
      copyAgentPrompts(),
      copyCodeGraphAssets('out/main')
    ],
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@shared': resolve('src/shared'),
        '@runtime': resolve('src/runtime')
      }
    },
    build: {
      rollupOptions: {
        // 独立 Worker 都以真实入口构建，不与 Electron main 共用执行线程。
        input: [
          'src/main/index.ts',
          'src/runtime/code-mode/quickjs/codeModeWorker.ts',
          'src/runtime/code-graph/worker/codeGraphWorker.ts'
        ]
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
    worker: {
      format: 'es'
    },
    // 避开项目常用的 5173：Windows 上项目服务可在同端口监听 :: 而不报错，
    // 内置浏览器访问 127.0.0.1 时会落到 Nova 自己的界面。
    // strictPort：electron-vite 按配置端口生成 ELECTRON_RENDERER_URL，Vite 顺延端口会让主窗口加载错地址。
    server: {
      host: '127.0.0.1',
      port: 17380,
      strictPort: true
    }
  }
})
