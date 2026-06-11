import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SkillService } from '../../../../src/runtime/skills/SkillService'

const md = (name: string, desc: string) =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}`

describe('SkillService', () => {
  let appRoot: string
  let builtinDir: string
  let globalDir: string
  let projectRoot: string
  let novaHome: string
  let service: SkillService

  beforeEach(() => {
    const ts = Date.now()
    appRoot = join(tmpdir(), `nova-svc-app-${ts}`)
    builtinDir = join(appRoot, '.nova', 'skills')
    globalDir = join(tmpdir(), `nova-svc-global-${ts}`)
    projectRoot = join(tmpdir(), `nova-svc-project-${ts}`)
    novaHome = join(tmpdir(), `nova-svc-home-${ts}`)
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
      novaHomeDir: novaHome,
      getAppPath: () => appRoot
    })
  })

  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
    rmSync(globalDir, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(novaHome, { recursive: true, force: true })
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

  it('toggle 持久化到 skill-state.json', () => {
    service.load(null)
    service.toggle('my-global', false)
    expect(service.get('my-global')?.enabled).toBe(false)

    const statePath = join(novaHome, 'skill-state.json')
    expect(existsSync(statePath)).toBe(true)
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as Record<string, boolean>
    expect(state['my-global']).toBe(false)

    const service2 = new SkillService({ globalDir, novaHomeDir: novaHome })
    service2.load(null)
    expect(service2.get('my-global')?.enabled).toBe(false)
  })

  it('import/export stub 抛出未实现', () => {
    service.load(null)
    expect(() => service.import({ location: 'global', zipPath: '/tmp/x.zip' })).toThrow(/尚未实现/)
    expect(() => service.export('my-global')).toThrow(/尚未实现/)
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
})
