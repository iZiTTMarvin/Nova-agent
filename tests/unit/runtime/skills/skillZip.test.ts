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
})
