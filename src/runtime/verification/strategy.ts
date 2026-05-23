/**
 * 验证命令选择策略
 *
 * 按优先级 test > lint > build 探测工作区可用的验证命令。
 * 通过检查 package.json scripts、常见配置文件来确定候选命令。
 */
import * as fs from 'fs'
import * as path from 'path'
import type { VerificationCandidate, VerificationCommandType } from './types'

/** 验证命令探测优先级 */
const COMMAND_PRIORITY: VerificationCommandType[] = ['test', 'lint', 'build']

/**
 * npm 系列候选命令
 * 每个 type 对应一组候选，按优先级排列
 */
const NPM_CANDIDATES: Record<VerificationCommandType, Array<{ cmd: string; pkgMgr: string }>> = {
  test: [
    { cmd: 'npm test', pkgMgr: 'npm' },
    { cmd: 'pnpm test', pkgMgr: 'pnpm' },
    { cmd: 'yarn test', pkgMgr: 'yarn' }
  ],
  lint: [
    { cmd: 'npm run lint', pkgMgr: 'npm' },
    { cmd: 'pnpm lint', pkgMgr: 'pnpm' },
    { cmd: 'yarn lint', pkgMgr: 'yarn' }
  ],
  build: [
    { cmd: 'npm run build', pkgMgr: 'npm' },
    { cmd: 'pnpm build', pkgMgr: 'pnpm' },
    { cmd: 'yarn build', pkgMgr: 'yarn' }
  ]
}

/** 非 npm 系列候选命令 */
const OTHER_CANDIDATES: Record<VerificationCommandType, Array<{ cmd: string; indicator: string }>> = {
  test: [
    { cmd: 'pytest', indicator: 'pytest.ini' },
    { cmd: 'pytest', indicator: 'pyproject.toml' },
    { cmd: 'cargo test', indicator: 'Cargo.toml' },
    { cmd: 'go test ./...', indicator: 'go.mod' }
  ],
  lint: [],
  build: [
    { cmd: 'cargo build', indicator: 'Cargo.toml' },
    { cmd: 'go build ./...', indicator: 'go.mod' }
  ]
}

/**
 * 从工作区中选择最佳验证命令
 *
 * 探测逻辑：
 * 1. 如果有 package.json 且有对应 script，用 npm 系列命令
 * 2. 如果有对应配置文件（pytest.ini、Cargo.toml 等），用非 npm 命令
 * 3. 找不到时返回 null
 */
export function selectVerificationCommand(workingDir: string): VerificationCandidate | null {
  for (const type of COMMAND_PRIORITY) {
    const candidate = findCandidate(workingDir, type)
    if (candidate) return candidate
  }
  return null
}

function findCandidate(workingDir: string, type: VerificationCommandType): VerificationCandidate | null {
  // 优先检查 npm 系
  const npmCandidate = findNpmCandidate(workingDir, type)
  if (npmCandidate) return npmCandidate

  // 再检查非 npm 系
  return findOtherCandidate(workingDir, type)
}

function findNpmCandidate(workingDir: string, type: VerificationCommandType): VerificationCandidate | null {
  const pkgJsonPath = path.join(workingDir, 'package.json')
  if (!fs.existsSync(pkgJsonPath)) return null

  try {
    const content = fs.readFileSync(pkgJsonPath, 'utf8')
    const pkg = JSON.parse(content)
    const scripts = pkg.scripts ?? {}

    const candidates = NPM_CANDIDATES[type]
    for (const { cmd, pkgMgr } of candidates) {
      // 提取 script 名：'npm test' → 'test', 'npm run lint' → 'lint'
      const scriptName = cmd.replace(/^npm (run )?/, '').replace(/^pnpm (run )?/, '').replace(/^yarn (run )?/, '')
      if (scripts[scriptName]) {
        return { type, command: cmd, source: `package.json scripts.${scriptName} (via ${pkgMgr})` }
      }
    }
  } catch {
    // package.json 解析失败，跳过
  }

  return null
}

function findOtherCandidate(workingDir: string, type: VerificationCommandType): VerificationCandidate | null {
  const candidates = OTHER_CANDIDATES[type]
  for (const { cmd, indicator } of candidates) {
    if (fs.existsSync(path.join(workingDir, indicator))) {
      return { type, command: cmd, source: `detected ${indicator}` }
    }
  }
  return null
}
