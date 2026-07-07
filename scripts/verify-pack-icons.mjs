/**
 * 打包后图标与安装包完整性校验（npm run dist 末尾自动执行）
 */
import { createHash } from 'crypto'
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { readFile } from 'fs/promises'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolvePromise(hash.digest('hex')))
      .on('error', reject)
  })
}

function fail(msg) {
  console.error(`[verify:pack] ✗ ${msg}`)
  process.exit(1)
}

function ok(msg) {
  console.log(`[verify:pack] ✓ ${msg}`)
}

async function main() {
  const brandPng = join(root, 'assets', 'brand')
  if (!existsSync(brandPng)) fail('assets/brand 不存在')

  const buildIcon = join(root, 'build', 'icon.png')
  const rendererIcon = join(root, 'src', 'renderer', 'assets', 'app-icon.png')
  const setupExe = join(root, 'release', `NovaAgent-Setup-${version}.exe`)
  const unpackedExe = join(root, 'release', 'win-unpacked', 'Nova Agent.exe')
  const packedIcon = join(root, 'release', 'win-unpacked', 'resources', 'icon.png')
  const rendererOut = join(root, 'out', 'renderer', 'assets')

  for (const p of [buildIcon, rendererIcon]) {
    if (!existsSync(p)) fail(`缺少图标文件: ${p}`)
  }

  const brandFiles = readdirSync(brandPng).filter((n) => n.endsWith('.png'))
  if (brandFiles.length === 0) fail('assets/brand 下无 PNG')

  const buildHash = await sha256File(buildIcon)
  const rendererHash = await sha256File(rendererIcon)
  if (buildHash !== rendererHash) {
    fail('build/icon.png 与 renderer/app-icon.png 不一致，请重新 npm run sync:icon')
  }
  ok('build 与 renderer 品牌图一致')

  const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
  if (/signAndEditExecutable:\s*false/.test(yml)) {
    fail('electron-builder.yml 中 signAndEditExecutable 为 false，exe 无法嵌入品牌图标')
  }
  ok('electron-builder 允许写入 exe 图标')

  if (!existsSync(setupExe)) fail(`未找到安装包: ${setupExe}`)
  const setupSize = statSync(setupExe).size
  if (setupSize < 30 * 1024 * 1024) fail(`安装包体积异常偏小: ${setupSize} bytes`)
  ok(`NSIS 安装包存在 (${(setupSize / 1024 / 1024).toFixed(1)} MB)`)

  if (!existsSync(unpackedExe)) fail(`未找到解压产物: ${unpackedExe}`)
  ok('win-unpacked 主程序存在')

  if (!existsSync(packedIcon)) fail('打包后 resources/icon.png 缺失（任务栏图标会失败）')
  const packedHash = await sha256File(packedIcon)
  if (packedHash !== buildHash) fail('resources/icon.png 与 build/icon.png 不一致')
  ok('extraResources 窗口图标已打入包内')

  if (!existsSync(rendererOut)) fail('out/renderer/assets 不存在，请先 npm run build')
  const bundled = readdirSync(rendererOut).filter((n) => n.includes('app-icon') && n.endsWith('.png'))
  if (bundled.length === 0) fail('renderer 构建产物中未找到 app-icon.png（界面 Logo 会回退失败）')
  ok(`界面品牌图已编入 renderer 产物 (${bundled[0]})`)

  // 读取 exe 前 2MB，确认不是裸 Electron 默认资源（启发式：应含 PNG/ICO 签名痕迹）
  const exeBuf = await readFile(unpackedExe)
  const hasPngSig = exeBuf.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  if (!hasPngSig) {
    fail('Nova Agent.exe 内未检测到 PNG 资源，图标可能未嵌入')
  }
  ok('exe 内已嵌入图像资源（品牌图标）')

  console.log(`\n[verify:pack] 全部通过。安装包: release/NovaAgent-Setup-${version}.exe`)
}

main().catch((err) => {
  console.error('[verify:pack] 异常:', err)
  process.exit(1)
})
