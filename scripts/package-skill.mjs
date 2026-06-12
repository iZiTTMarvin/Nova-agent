#!/usr/bin/env node
/**
 * 将单个 skill 目录打包为 zip（开发/调试）
 * 用法：node scripts/package-skill.mjs <skill目录> [输出zip路径]
 */
import { existsSync, readdirSync } from 'fs'
import { basename, join, resolve } from 'path'
import { execSync } from 'child_process'

const skillDir = resolve(process.argv[2] ?? '')
if (!skillDir || !existsSync(skillDir)) {
  console.error('用法: node scripts/package-skill.mjs <skill目录> [输出.zip]')
  process.exit(1)
}

if (!existsSync(join(skillDir, 'SKILL.md'))) {
  console.error('目录中缺少 SKILL.md')
  process.exit(1)
}

const dirName = basename(skillDir)
const outZip = resolve(process.argv[3] ?? `${dirName}.zip`)

if (process.platform === 'win32') {
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${skillDir.replace(/'/g, "''")}' -DestinationPath '${outZip.replace(/'/g, "''")}' -Force"`,
    { stdio: 'inherit' }
  )
} else {
  execSync(`zip -r "${outZip}" "${dirName}"`, { cwd: join(skillDir, '..'), stdio: 'inherit' })
}

console.log(`已打包: ${outZip}`)
console.log('包含文件:', readdirSync(skillDir).join(', '))
