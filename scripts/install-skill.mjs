#!/usr/bin/env node
/**
 * CLI：从 zip 或 https URL 安装 skill 到 ~/.nova/skills 或项目 .nova/skills
 * 用法：node scripts/install-skill.mjs <zip路径|https-url> [--project <工作区路径>]
 */
import { existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'

const args = process.argv.slice(2)
if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
  console.log(`用法: node scripts/install-skill.mjs <zip|https-url> [--project <workspace>]`)
  process.exit(args.length === 0 ? 1 : 0)
}

let target = args[0]
let location = 'global'
let workspaceRoot = null

for (let i = 1; i < args.length; i++) {
  if (args[i] === '--project') {
    location = 'project'
    workspaceRoot = args[++i]
    if (!workspaceRoot) {
      console.error('--project 需要工作区路径')
      process.exit(1)
    }
  }
}

if (location === 'project' && !workspaceRoot) {
  console.error('项目级安装需要 --project <workspace>')
  process.exit(1)
}

// 动态加载编译后的 SkillService（需先 npm run build）
const servicePath = resolve('out/main/runtime/skills/SkillService.js')
if (!existsSync(servicePath)) {
  console.error('请先执行 npm run build 生成 out/ 目录')
  process.exit(1)
}

const { SkillService } = await import(pathToFileURL(servicePath).href)
const service = new SkillService({
  globalDir: join(homedir(), '.nova', 'skills'),
  novaHomeDir: join(homedir(), '.nova')
})

if (workspaceRoot) {
  service.load(resolve(workspaceRoot))
} else {
  service.load(null)
}

const input =
  target.startsWith('https://')
    ? { url: target, location }
    : { zipPath: resolve(target), location }

try {
  const imported = await service.import(input)
  console.log(`已安装技能: ${imported.name} (${imported.source})`)
} catch (err) {
  console.error('安装失败:', err.message)
  process.exit(1)
}
