import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import {
  extractZip,
  findSkillRoot,
  validateSkillDirectory,
  createTempSkillDir,
  isZipPath
} from '../../../../src/runtime/skills/skillZip'

const md = (name: string) =>
  `---\nname: ${name}\ndescription: test skill\n---\n# ${name}`

/** 使用系统命令创建测试 zip（Windows PowerShell / Unix zip） */
function createTestZip(skillDir: string, zipPath: string): void {
  if (process.platform === 'win32') {
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${skillDir.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force"`,
      { stdio: 'ignore' }
    )
    return
  }
  execSync(`zip -r "${zipPath}" .`, { cwd: skillDir, stdio: 'ignore' })
}

/**
 * 在 staging 目录写出指定数量的文件，再用系统 zip 工具打包。
 * 用于 C6 回归测试（zip bomb 文件数 / 总大小）。
 */
function createZipWithFileCount(stagingDir: string, zipPath: string, count: number): void {
  mkdirSync(stagingDir, { recursive: true })
  for (let i = 0; i < count; i++) {
    writeFileSync(join(stagingDir, `f${i}.txt`), 'x')
  }
  if (process.platform === 'win32') {
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${join(stagingDir, '*').replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force"`,
      { stdio: 'ignore' }
    )
    return
  }
  execSync(`zip -r "${zipPath}" .`, { cwd: stagingDir, stdio: 'ignore' })
}

/** 在 staging 目录写出指定数量的大文件，再用系统 zip 工具打包 */
function createZipWithBigFiles(
  stagingDir: string,
  zipPath: string,
  fileCount: number,
  bytesPerFile: number
): void {
  mkdirSync(stagingDir, { recursive: true })
  const buf = Buffer.alloc(bytesPerFile, 0x41)
  for (let i = 0; i < fileCount; i++) {
    writeFileSync(join(stagingDir, `big${i}.bin`), buf)
  }
  if (process.platform === 'win32') {
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${join(stagingDir, '*').replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force"`,
      { stdio: 'ignore' }
    )
    return
  }
  // 用 -0 关闭压缩，保证解压后大小等于原始大小（zip bomb 测试需要可预测的 uncompressed size）
  execSync(`zip -0 -r "${zipPath}" .`, { cwd: stagingDir, stdio: 'ignore' })
}

describe('skillZip', () => {
  let workDir: string

  beforeEach(() => {
    workDir = join(tmpdir(), `nova-zip-${Date.now()}`)
    mkdirSync(workDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it('解压 zip 并发现根目录 SKILL.md', async () => {
    const skillDir = join(workDir, 'zip-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), md('zip-skill'))

    const zipPath = join(workDir, 'skill.zip')
    createTestZip(skillDir, zipPath)

    const extractDir = join(workDir, 'out')
    await extractZip(zipPath, extractDir)
    const root = findSkillRoot(extractDir)
    const { name } = validateSkillDirectory(root)
    expect(name).toBe('zip-skill')
  })

  it('isZipPath 识别扩展名', () => {
    expect(isZipPath('/a/b.skill.zip')).toBe(true)
    expect(isZipPath('/a/b.tar')).toBe(false)
  })

  it('createTempSkillDir 可清理', () => {
    const { dir, cleanup } = createTempSkillDir('t')
    expect(existsSync(dir)).toBe(true)
    cleanup()
    expect(existsSync(dir)).toBe(false)
  })

  // ── C6 回归：zip bomb 防护 ────────────────────────────────

  it('解压文件数超过上限时拒绝并清理（zip bomb 防护）', async () => {
    // 构造 1001 个小文件的 zip，触发 MAX_EXTRACTED_FILE_COUNT=1000
    const stagingDir = join(workDir, 'staging-files')
    const zipPath = join(workDir, 'bomb-files.zip')
    createZipWithFileCount(stagingDir, zipPath, 1001)

    const extractDir = join(workDir, 'out-files')
    await expect(extractZip(zipPath, extractDir)).rejects.toThrow(/zip bomb|文件数/)
    // 失败时必须清理半成品，避免污染目标目录
    expect(existsSync(extractDir)).toBe(false)
  })

  it('解压总大小超过上限时拒绝并清理（zip bomb 防护）', async () => {
    // 构造一个总大小 > 100MB 的 zip：2 个 60MB 文件，触发 MAX_EXTRACTED_TOTAL_SIZE
    // 用 -0 不压缩，保证 uncompressedSize 等于原始大小
    const stagingDir = join(workDir, 'staging-size')
    const zipPath = join(workDir, 'bomb-size.zip')
    createZipWithBigFiles(stagingDir, zipPath, 2, 60 * 1024 * 1024)

    const extractDir = join(workDir, 'out-size')
    await expect(extractZip(zipPath, extractDir)).rejects.toThrow(/zip bomb|大小|过大/)
    expect(existsSync(extractDir)).toBe(false)
  })
})
