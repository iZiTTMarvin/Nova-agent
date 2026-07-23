/** 将 active 品牌 PNG 同步到构建目录和 renderer，供窗口、任务栏与界面 Logo 使用。 */
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const brandDir = join(root, 'assets', 'brand')
const buildDir = join(root, 'build')
const rendererIcon = join(root, 'src', 'renderer', 'assets', 'app-icon.png')
const outFile = join(buildDir, 'icon.png')
const activeBrandFile = 'nova-agent-icon-v6-nova-mark-512.png'

function pickBrandPng() {
  if (!existsSync(brandDir)) {
    throw new Error(`品牌目录不存在: ${brandDir}`)
  }

  const activePath = join(brandDir, activeBrandFile)
  if (!existsSync(activePath)) {
    throw new Error(`缺少 active 品牌图标: ${activePath}`)
  }
  return activePath
}

const src = pickBrandPng()
mkdirSync(buildDir, { recursive: true })
mkdirSync(dirname(rendererIcon), { recursive: true })
copyFileSync(src, outFile)
copyFileSync(src, rendererIcon)
const rel = (p) => p.replace(root + '\\', '').replace(root + '/', '')
console.log(`[sync:icon] ${rel(src)} -> build/icon.png`)
console.log(`[sync:icon] ${rel(src)} -> src/renderer/assets/app-icon.png`)
