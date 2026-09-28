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
          'src/runtime/code-graph/worker/codeGraphWorker.ts',
          'src/runtime/learning/storage/learningDbWorker.ts'
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
    // electron-vite 的 renderer preset 默认 minify:false，发行版首屏会以未压缩形式
    // 加载全部 JS/CSS。main/preload 同样默认 false 但故意保持不压：主进程日志会进
    // 用户诊断包（src/main/diagnostics/diagnosticsExport.ts），混淆堆栈会让报障材料失效。
    // sourcemap 用 hidden 而非 true：安装包不含 .map（见 electron-builder.yml），
    // 写 sourceMappingURL 会让每次报错都发一次 404 并污染控制台。
    build: {
      minify: 'esbuild',
      sourcemap: 'hidden',
      // 首屏体积门禁（tests/perf/firstScreenBudget.test.ts）需要它才能沿
      // 静态 imports 求首屏真实闭包，否则量到的只是 entry 文件本身。
      manifest: true
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
