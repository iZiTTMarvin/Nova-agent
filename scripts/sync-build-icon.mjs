/** 将 active 品牌 PNG 同步到构建目录和 renderer，并按需生成多尺寸 icon.ico。 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'fs'
import { writeFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { verifyBrandAssets } from './verify-brand-assets.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const brandDir = join(root, 'assets', 'brand')
const buildDir = join(root, 'build')
const rendererIcon = join(root, 'src', 'renderer', 'assets', 'app-icon.png')
const outFile = join(buildDir, 'icon.png')
const icoFile = join(buildDir, 'icon.ico')
const activeBrandFile = 'nova-agent-icon-v7-cosmic-oracle-512.png'

/** exe / 安装器 / 快捷方式各 DPI 使用的尺寸档 */
const ICO_SIZES = [256, 128, 64, 48, 32, 16]

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

/**
 * 生成 PNG 内嵌式多尺寸 ICO（Windows Vista+ 支持）。
 * 仅在源变更（ico 缺失或早于品牌 PNG）时重建，避免给每次 dev 启动加耗时。
 */
async function writeIcoIfStale(srcPng) {
  if (existsSync(icoFile) && statSync(icoFile).mtimeMs >= statSync(srcPng).mtimeMs) {
    return false
  }

  const { default: sharp } = await import('sharp')
  const images = await Promise.all(
    ICO_SIZES.map(async size => ({
      size,
      buf: await sharp(srcPng).resize(size, size).png().toBuffer()
    }))
  )

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  const entries = Buffer.alloc(16 * images.length)
  let offset = header.length + entries.length
  const blobs = []
  images.forEach((image, i) => {
    const base = i * 16
    const dimension = image.size >= 256 ? 0 : image.size
    entries.writeUInt8(dimension, base)
    entries.writeUInt8(dimension, base + 1)
    entries.writeUInt16LE(1, base + 4)
    entries.writeUInt16LE(32, base + 6)
    entries.writeUInt32LE(image.buf.length, base + 8)
    entries.writeUInt32LE(offset, base + 12)
    offset += image.buf.length
    blobs.push(image.buf)
  })

  await writeFile(icoFile, Buffer.concat([header, entries, ...blobs]))
  return true
}

const src = pickBrandPng()
await verifyBrandAssets()
mkdirSync(buildDir, { recursive: true })
mkdirSync(dirname(rendererIcon), { recursive: true })
copyFileSync(src, outFile)
copyFileSync(src, rendererIcon)
const icoWritten = await writeIcoIfStale(src)
const rel = (p) => p.replace(root + '\\', '').replace(root + '/', '')
console.log(`[sync:icon] ${rel(src)} -> build/icon.png`)
console.log(`[sync:icon] ${rel(src)} -> src/renderer/assets/app-icon.png`)
if (icoWritten) {
  console.log(`[sync:icon] ${rel(src)} -> build/icon.ico (${ICO_SIZES.join('/')}px)`)
}
