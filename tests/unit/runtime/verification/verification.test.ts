import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { selectVerificationCommand } from '../../../../src/runtime/verification/strategy'
import { runVerification } from '../../../../src/runtime/verification/service'
import { formatVerificationSummary } from '../../../../src/runtime/verification/format'
import type { VerificationResult } from '../../../../src/runtime/verification/types'

describe('验证服务', () => {
  describe('strategy — 命令选择', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-test-'))
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('有 npm test script 时选择 npm test', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'test', scripts: { test: 'jest' } })
      )

      const result = selectVerificationCommand(tmpDir)

      expect(result).not.toBeNull()
      expect(result!.type).toBe('test')
      expect(result!.command).toContain('npm test')
      expect(result!.source).toContain('package.json')
    })

    it('有 lint 无 test 时选择 lint', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'test', scripts: { lint: 'eslint .' } })
      )

      const result = selectVerificationCommand(tmpDir)

      expect(result).not.toBeNull()
      expect(result!.type).toBe('lint')
    })

    it('只有 build 时选择 build', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'test', scripts: { build: 'tsc' } })
      )

      const result = selectVerificationCommand(tmpDir)

      expect(result).not.toBeNull()
      expect(result!.type).toBe('build')
    })

    it('没有 package.json 也没有其他配置时返回 null', () => {
      const result = selectVerificationCommand(tmpDir)
      expect(result).toBeNull()
    })

    it('有 pytest.ini 时选择 pytest', () => {
      fs.writeFileSync(path.join(tmpDir, 'pytest.ini'), '[pytest]\n')
      const result = selectVerificationCommand(tmpDir)
      expect(result).not.toBeNull()
      expect(result!.command).toBe('pytest')
    })

    it('有 Cargo.toml 时选择 cargo test', () => {
      fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"\n')
      const result = selectVerificationCommand(tmpDir)
      expect(result).not.toBeNull()
      expect(result!.command).toBe('cargo test')
    })

    it('test 优先于 lint 和 build', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          name: 'test',
          scripts: { test: 'jest', lint: 'eslint .', build: 'tsc' }
        })
      )

      const result = selectVerificationCommand(tmpDir)
      expect(result!.type).toBe('test')
    })
  })

  describe('service — 验证流程', () => {
    it('plan 模式不验证', async () => {
      const result = await runVerification({
        workingDir: '/tmp',
        mode: 'plan',
        hasModifications: true
      })
      expect(result).toBeNull()
    })

    it('无文件修改时不验证', async () => {
      const result = await runVerification({
        workingDir: '/tmp',
        mode: 'default',
        hasModifications: false
      })
      expect(result).toBeNull()
    })

    it('找不到验证命令时不验证', async () => {
      // 使用空临时目录，不会有 package.json
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-test-'))
      try {
        const result = await runVerification({
          workingDir: tmpDir,
          mode: 'default',
          hasModifications: true,
          permissionCallback: async () => true
        })
        expect(result).toBeNull()
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it('default 模式无 permissionCallback 时跳过', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-test-'))
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'test', scripts: { test: 'jest' } })
      )
      try {
        const result = await runVerification({
          workingDir: tmpDir,
          mode: 'default',
          hasModifications: true
          // 故意不传 permissionCallback
        })
        expect(result).toBeNull()
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it('default 模式用户拒绝验证时跳过', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-test-'))
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'test', scripts: { test: 'jest' } })
      )
      try {
        const result = await runVerification({
          workingDir: tmpDir,
          mode: 'default',
          hasModifications: true,
          permissionCallback: async () => false
        })
        expect(result).toBeNull()
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })
  })

  describe('formatVerificationSummary — 结果格式化', () => {
    it('成功时显示通过标记', () => {
      const result: VerificationResult = {
        command: 'npm test',
        type: 'test',
        success: true,
        output: '3 tests passed',
        exitCode: 0,
        durationMs: 1500
      }

      const summary = formatVerificationSummary(result)
      expect(summary).toContain('✓')
      expect(summary).toContain('测试通过')
      expect(summary).toContain('1.5s')
      expect(summary).toContain('npm test')
    })

    it('失败时显示失败标记和输出摘要', () => {
      const result: VerificationResult = {
        command: 'npm test',
        type: 'test',
        success: false,
        output: 'line1\nline2\nline3\nline4\nline5\nline6',
        exitCode: 1,
        durationMs: 3000
      }

      const summary = formatVerificationSummary(result)
      expect(summary).toContain('✗')
      expect(summary).toContain('测试失败')
      expect(summary).toContain('line6')
    })
  })
})
