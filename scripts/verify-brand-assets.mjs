import { existsSync, readdirSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const brandDir = join(root, 'assets', 'brand')

export async function verifyBrandAssets() {
  if (!existsSync(brandDir)) {
    throw new Error(`品牌目录不存在: ${brandDir}`)
  }

  const brandFiles = readdirSync(brandDir).filter((name) => name.endsWith('.png'))
  if (brandFiles.length === 0) {
    throw new Error('assets/brand 下没有 PNG 品牌资源')
  }

  for (const name of brandFiles) {
    const path = join(brandDir, name)
    let decoded
    try {
      decoded = await sharp(path)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
    } catch (error) {
      throw new Error(`品牌图标无法解码: ${name}`, { cause: error })
    }

    const { data, info } = decoded
    if (info.width !== info.height) {
      throw new Error(`品牌图标必须是正方形: ${name} (${info.width}x${info.height})`)
    }

    const corners = [
      0,
      (info.width - 1) * info.channels,
      (info.height - 1) * info.width * info.channels,
      (info.height * info.width - 1) * info.channels,
    ]
    if (corners.some((offset) => data[offset + 3] !== 0)) {
      throw new Error(`品牌图标四角必须透明: ${name}`)
    }

    console.log(`[verify:brand] ✓ ${name} (${info.width}x${info.height})`)
  }
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  verifyBrandAssets()
    .then(() => console.log('[verify:brand] 全部通过'))
    .catch((error) => {
      console.error(`[verify:brand] ✗ ${error.message}`)
      process.exitCode = 1
    })
}
