import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Plugin } from 'vite'
import codeGraphAssetManifest from './codeGraphAssets.json'

const CODE_GRAPH_WASM_ASSETS = Object.freeze(
  codeGraphAssetManifest.map(({ source, fileName }) => [source, fileName] as const)
)

/** 将固定版本 grammar 复制到运行目录；缺失时构建必须显式失败。 */
export function copyCodeGraphAssets(outputRoot: string): Plugin {
  return {
    name: `copy-code-graph-assets-${outputRoot.replace(/[^a-z0-9]+/gi, '-')}`,
    closeBundle() {
      const destinationRoot = resolve(outputRoot, 'code-graph', 'grammars')
      mkdirSync(destinationRoot, { recursive: true })
      for (const [sourcePath, fileName] of CODE_GRAPH_WASM_ASSETS) {
        const source = resolve(sourcePath)
        if (!existsSync(source)) {
          throw new Error(`Code Graph WASM 资源缺失：${source}`)
        }
        const destination = resolve(destinationRoot, fileName)
        mkdirSync(dirname(destination), { recursive: true })
        cpSync(source, destination)
      }
    }
  }
}

