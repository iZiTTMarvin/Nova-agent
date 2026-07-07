/**
 * 将 assets/brand 下的品牌 PNG 同步到 build/icon.png，供 electron-builder 与窗口图标使用。
 * 优先 512px，其次 1024px / 256px。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const brandDir = join(root, 'assets', 'brand')
const buildDir = join(root, 'build')
const rendererIcon = join(root, 'src', 'renderer', 'assets', 'app-icon.png')
const outFile = join(buildDir, 'icon.png')

/** 按优先级挑选最合适的源 PNG */
function pickBrandPng() {
  if (!existsSync(brandDir)) {
    throw new Error(`品牌目录不存在: ${brandDir}`)
  }

  const pngFiles = readdirSync(brandDir).filter((name) => name.toLowerCase().endsWith('.png'))
  if (pngFiles.length === 0) {
    throw new Error(`未在 ${brandDir} 找到 PNG 图标`)
  }

  const priority = (name) => {
    if (name.includes('-512.')) return 0
    if (name.includes('-1024.')) return 1
    if (name.includes('-256.')) return 2
    return 3
  }

  pngFiles.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b))
  return join(brandDir, pngFiles[0])
}

const src = pickBrandPng()
mkdirSync(buildDir, { recursive: true })
mkdirSync(dirname(rendererIcon), { recursive: true })
copyFileSync(src, outFile)
copyFileSync(src, rendererIcon)
const rel = (p) => p.replace(root + '\\', '').replace(root + '/', '')
console.log(`[sync:icon] ${rel(src)} -> build/icon.png`)
console.log(`[sync:icon] ${rel(src)} -> src/renderer/assets/app-icon.png`)
