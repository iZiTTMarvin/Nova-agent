import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { SkillService, toCatalogDiagnostics } from '../../../../src/runtime/skills/SkillService'
import { extractZip, findSkillRoot, validateSkillDirectory } from '../../../../src/runtime/skills/skillZip'
import { saveNovaSettings } from '../../../../src/runtime/settings/novaSettings'

const md = (name: string, desc: string) =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}`

describe('SkillService', () => {
  let appRoot: string
  let builtinDir: string
  let globalDir: string
  let projectRoot: string
  let service: SkillService

  beforeEach(() => {
    const ts = Date.now()
    appRoot = join(tmpdir(), `nova-svc-app-${ts}`)
    builtinDir = join(appRoot, '.nova', 'skills')
    globalDir = join(tmpdir(), `nova-svc-global-${ts}`)
    projectRoot = join(tmpdir(), `nova-svc-project-${ts}`)
    mkdirSync(builtinDir, { recursive: true })
    mkdirSync(globalDir, { recursive: true })
    mkdirSync(join(projectRoot, '.nova', 'skills'), { recursive: true })

    const write = (base: string, dirName: string, content: string) => {
      const dir = join(base, dirName)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), content)
    }

    write(builtinDir, 'onboard', md('onboard', 'builtin guide'))
    write(builtinDir, 'new', md('new', 'template'))
    write(globalDir, 'my-global', md('my-global', 'global skill'))

    service = new SkillService({
      globalDir,
      getAppPath: () => appRoot
    })
  })

  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
    rmSync(globalDir, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('load 后 list 包含 builtin 与 global 技能', () => {
    service.load(null)
    const names = service.list().map(s => s.name)
    expect(names).toContain('my-global')
    expect(names).toContain('onboard')
    expect(names).toContain('new')
  })

  it('create 写入 global 目录并可 list', () => {
    service.load(null)
    const created = service.create({
      name: 'test-skill',
      description: '测试技能',
      body: '# Hello',
      location: 'global'
    })
    expect(created.name).toBe('test-skill')
    expect(existsSync(join(globalDir, 'test-skill', 'SKILL.md'))).toBe(true)
    expect(service.list().some(s => s.name === 'test-skill')).toBe(true)
  })

  it('delete 拒绝 builtin 并允许删除 global', () => {
    service.load(null)
    expect(() => service.delete('onboard')).toThrow(/无法删除/)

    service.create({
      name: 'to-delete',
      description: 'd',
      body: 'x',
      location: 'global'
    })
    service.delete('to-delete')
    expect(service.get('to-delete')).toBeNull()
  })

  it('export 打包技能目录并补全 .zip 后缀', async () => {
    service.load(null)
    const zipPath = await service.export('my-global', join(tmpdir(), `nova-export-${Date.now()}`))
    expect(zipPath.endsWith('.zip')).toBe(true)
    expect(existsSync(zipPath)).toBe(true)

    const extractDir = join(tmpdir(), `nova-export-out-${Date.now()}`)
    await extractZip(zipPath, extractDir)
    expect(validateSkillDirectory(findSkillRoot(extractDir)).name).toBe('my-global')

    rmSync(zipPath, { force: true })
    rmSync(extractDir, { recursive: true, force: true })
  })

  it('export 不存在的技能或缺 SKILL.md 时报错', async () => {
    service.load(null)
    await expect(service.export('no-such-skill', join(tmpdir(), 'x'))).rejects.toThrow(/不存在/)

    service.create({ name: 'broken-export', description: 'd', body: 'x', location: 'global' })
    rmSync(join(globalDir, 'broken-export', 'SKILL.md'))
    await expect(
      service.export('broken-export', join(tmpdir(), `nova-export-${Date.now()}`))
    ).rejects.toThrow(/缺少 SKILL.md/)
  })

  it('import 从 zip 解压并写入 global 目录', async () => {
    service.load(null)
    const importName = 'imported-skill'
    const srcDir = join(tmpdir(), `nova-import-src-${Date.now()}`, importName)
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'SKILL.md'), md(importName, 'from zip'))

    const zipPath = join(tmpdir(), `nova-import-${Date.now()}.zip`)
    if (process.platform === 'win32') {
      execSync(
        `powershell -NoProfile -Command "Compress-Archive -Path '${srcDir.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force"`,
        { stdio: 'ignore' }
      )
    } else {
      execSync(`zip -r "${zipPath}" .`, { cwd: srcDir, stdio: 'ignore' })
    }

    const imported = await service.import({ location: 'global', zipPath })
    expect(imported.name).toBe(importName)
    expect(existsSync(join(globalDir, importName, 'SKILL.md'))).toBe(true)
    expect(service.get(importName)?.description).toBe('from zip')

    rmSync(srcDir, { recursive: true, force: true })
    rmSync(zipPath, { force: true })
  })

  it('第三方来源默认不读取，用户开启后原地读取并随开关即时增删', () => {
    const fakeUser = join(tmpdir(), `nova-fake-user-${Date.now()}`)
    const prevUserProfile = process.env.USERPROFILE
    process.env.USERPROFILE = fakeUser
    const writeThird = (root: string, name: string) => {
      mkdirSync(join(fakeUser, root, 'skills', name), { recursive: true })
      writeFileSync(join(fakeUser, root, 'skills', name, 'SKILL.md'), md(name, 'third party'))
    }
    writeThird('.claude', 'claude-only')
    writeThird('.agents', 'agents-only')

    try {
      const svc = new SkillService({ globalDir, getAppPath: () => appRoot })
      svc.load(null)
      expect(svc.get('claude-only')).toBeNull()
      expect(svc.get('agents-only')).toBeNull()

      saveNovaSettings({ thirdPartySkillSources: { agents: true, claude: false } })
      svc.reload()
      const agentsSkill = svc.getRegistry().get('agents-only')
      expect(agentsSkill?.source).toBe('third_party')
      expect(agentsSkill?.directory).toBe(join(fakeUser, '.agents', 'skills', 'agents-only'))
      expect(svc.get('claude-only')).toBeNull()
      expect(svc.getThirdPartySources().find(source => source.id === 'agents')).toMatchObject({
        enabled: true,
        locations: [expect.objectContaining({ scope: 'user', exists: true, count: 1 })]
      })
      expect(svc.getWatchRoots()).toContain(join(fakeUser, '.agents', 'skills'))

      saveNovaSettings({ thirdPartySkillSources: { agents: false, claude: true } })
      svc.reload()
      expect(svc.get('agents-only')).toBeNull()
      expect(svc.get('claude-only')?.source).toBe('third_party')
      expect(existsSync(join(fakeUser, '.nova', 'imported'))).toBe(false)
    } finally {
      process.env.USERPROFILE = prevUserProfile
      rmSync(fakeUser, { recursive: true, force: true })
    }
  })

  it('切换 workspace 后加载 project 技能', () => {
    const projSkillDir = join(projectRoot, '.nova', 'skills', 'proj-only')
    mkdirSync(projSkillDir, { recursive: true })
    writeFileSync(join(projSkillDir, 'SKILL.md'), md('proj-only', 'project skill'))

    service.load(projectRoot)
    expect(service.get('proj-only')).not.toBeNull()

    service.load(null)
    expect(service.get('proj-only')).toBeNull()
  })

  it('目录诊断覆盖加载失败与来源遮蔽，且排序稳定', () => {
    // 无效 frontmatter：无 description 且正文为空；带 agent 字段也不叠加次级诊断
    const badDir = join(globalDir, 'bad-skill')
    mkdirSync(badDir, { recursive: true })
    writeFileSync(join(badDir, 'SKILL.md'), '---\nname: bad-skill\nagent: review\n---\n')
    // 同名遮蔽：global 覆盖 builtin
    const dupDir = join(globalDir, 'onboard')
    mkdirSync(dupDir, { recursive: true })
    writeFileSync(join(dupDir, 'SKILL.md'), md('onboard', 'global override'))
    // 模式受限：仅 review 可用
    const gatedDir = join(globalDir, 'review-only')
    mkdirSync(gatedDir, { recursive: true })
    writeFileSync(
      join(gatedDir, 'SKILL.md'),
      '---\nname: review-only\ndescription: gated\nagent: review\n---\nbody'
    )

    service.load(null)
    const diagnostics = toCatalogDiagnostics(service.getRegistry())

    const loadError = diagnostics.find(d => d.code === 'load_error' && d.skillName === 'bad-skill')
    expect(loadError).toBeDefined()
    expect(loadError?.path).toContain('bad-skill')
    expect(
      diagnostics.filter(d => d.skillName === 'bad-skill').every(d => d.code === 'load_error')
    ).toBe(true)

    const shadowed = diagnostics.find(d => d.code === 'shadowed' && d.skillName === 'onboard')
    expect(shadowed?.message).toContain('内置')

    const restricted = diagnostics.find(
      d => d.code === 'profile_restricted' && d.skillName === 'review-only'
    )
    expect(restricted?.message).toContain('review')

    const keys = diagnostics.map(d => d.skillName ?? d.path ?? '')
    expect([...keys].sort((a, b) => a.localeCompare(b))).toEqual(keys)

    // 目录列表本身按名称稳定排序
    const names = service.list().map(s => s.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
  })
})
