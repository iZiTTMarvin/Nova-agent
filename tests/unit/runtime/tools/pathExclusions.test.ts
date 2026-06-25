import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { BUILD_SKIP_DIRS, isPathSkipped, loadIgnoreMatcher } from '../../../../src/runtime/tools/pathExclusions'

const TMP = join(process.cwd(), '.test-workspace-exclusions')

describe('pathExclusions', () => {
  describe('BUILD_SKIP_DIRS', () => {
    it('包含 Java/Maven 卡死根因 target/', () => {
      expect(BUILD_SKIP_DIRS.has('target')).toBe(true)
    })

    it('包含常见构建产物目录', () => {
      for (const dir of ['node_modules', 'dist', 'build', 'out', 'bin', 'obj', '.gradle']) {
        expect(BUILD_SKIP_DIRS.has(dir)).toBe(true)
      }
    })

    it('包含 VCS 目录', () => {
      for (const dir of ['.git', '.svn', '.hg', '.bzr', '.jj']) {
        expect(BUILD_SKIP_DIRS.has(dir)).toBe(true)
      }
    })

    it('包含 Python 缓存目录', () => {
      for (const dir of ['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache']) {
        expect(BUILD_SKIP_DIRS.has(dir)).toBe(true)
      }
    })
  })

  describe('isPathSkipped', () => {
    it('命中构建产物目录返回 true', () => {
      expect(isPathSkipped('target')).toBe(true)
      expect(isPathSkipped('node_modules')).toBe(true)
      expect(isPathSkipped('dist')).toBe(true)
    })

    it('隐藏目录(.开头)返回 true', () => {
      expect(isPathSkipped('.git')).toBe(true)
      expect(isPathSkipped('.vscode')).toBe(true)
      expect(isPathSkipped('.env')).toBe(true)
    })

    it('普通目录/文件返回 false', () => {
      expect(isPathSkipped('src')).toBe(false)
      expect(isPathSkipped('main.ts')).toBe(false)
      expect(isPathSkipped('README.md')).toBe(false)
    })

    it('空字符串返回 false', () => {
      expect(isPathSkipped('')).toBe(false)
    })
  })

  describe('loadIgnoreMatcher', () => {
    beforeEach(() => {
      mkdirSync(TMP, { recursive: true })
    })

    afterEach(() => {
      rmSync(TMP, { recursive: true, force: true })
    })

    it('无 .gitignore 时永不忽略', async () => {
      const matcher = await loadIgnoreMatcher(TMP)
      expect(matcher('foo.ts', false)).toBe(false)
      expect(matcher('dist/output.js', false)).toBe(false)
    })

    it('匹配 .gitignore 中的目录模式', async () => {
      writeFileSync(join(TMP, '.gitignore'), 'logs/\n*.log\n')
      const matcher = await loadIgnoreMatcher(TMP)

      expect(matcher('logs/app.log', false)).toBe(true)
      expect(matcher('logs', true)).toBe(true)
      expect(matcher('error.log', false)).toBe(true)
      expect(matcher('src/main.ts', false)).toBe(false)
    })

    it('支持 ! 取反模式覆盖之前的忽略', async () => {
      writeFileSync(join(TMP, '.gitignore'), '*.log\n!important.log\n')
      const matcher = await loadIgnoreMatcher(TMP)

      expect(matcher('debug.log', false)).toBe(true)
      // !important.log 取反，最后匹配规则生效 → 不忽略
      expect(matcher('important.log', false)).toBe(false)
    })

    it('目录模式通过祖先继承匹配子文件', async () => {
      writeFileSync(join(TMP, '.gitignore'), 'vendor/\n')
      const matcher = await loadIgnoreMatcher(TMP)

      // vendor/build/foo.ts 的祖先 "vendor" 命中模式 → 整棵子树被忽略
      expect(matcher('vendor/build/foo.ts', false)).toBe(true)
      expect(matcher('vendor', true)).toBe(true)
    })

    it('注释行和空行被忽略', async () => {
      writeFileSync(join(TMP, '.gitignore'), '# comment\n\ntmp\n')
      const matcher = await loadIgnoreMatcher(TMP)

      expect(matcher('tmp/foo', false)).toBe(true)
    })
  })
})
