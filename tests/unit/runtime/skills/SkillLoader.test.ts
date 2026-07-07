import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SkillLoader, resolveBuiltinSkillsDir, resolveDevBuiltinDir } from '../../../../src/runtime/skills/SkillLoader'

function writeSkill(base: string, dirName: string, content: string): void {
  const dir = join(base, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), content)
}

const md = (name: string, desc: string, extra = '') =>
  `---\nname: ${name}\ndescription: ${desc}\n${extra}---\n# ${name}`

describe('SkillLoader', () => {
  let builtinDir: string
  let globalDir: string
  let projectDir: string

  beforeEach(() => {
    const ts = Date.now()
    builtinDir = join(tmpdir(), `nova-builtin-${ts}`)
    globalDir = join(tmpdir(), `nova-global-${ts}`)
    projectDir = join(tmpdir(), `nova-project-${ts}`)
    mkdirSync(builtinDir, { recursive: true })
    mkdirSync(globalDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(builtinDir, { recursive: true, force: true })
    rmSync(globalDir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('按优先级 project 覆盖 global', () => {
    writeSkill(globalDir, 'commit', md('commit', 'global'))
    writeSkill(projectDir, 'commit', md('commit', 'project'))
    const loader = SkillLoader.loadAll({ globalDir, projectDir })
    expect(loader.get('commit')?.description).toBe('project')
    expect(loader.getShadowed()['commit']).toBe('global')
  })

  it('builtin 被 global 覆盖并记录 shadow', () => {
    writeSkill(builtinDir, 'onboard', md('onboard', 'builtin'))
    writeSkill(globalDir, 'onboard', md('onboard', 'global'))
    const loader = SkillLoader.loadAll({ builtinDir, globalDir })
    expect(loader.get('onboard')?.description).toBe('global')
    expect(loader.getShadowed()['onboard']).toBe('builtin')
  })

  it('非法 manifest 入 errors 不中断扫描', () => {
    writeSkill(globalDir, 'bad', 'not yaml')
    writeSkill(globalDir, 'good', md('good', 'ok'))
    const loader = SkillLoader.loadAll({ globalDir })
    expect(loader.get('good')).toBeDefined()
    expect(loader.getErrors().length).toBeGreaterThan(0)
  })

  it('listForContext 过滤 modelInvocable 与 agent 域', () => {
    writeSkill(globalDir, 'a', md('a', 'd', 'disable-model-invocation: true\n'))
    writeSkill(globalDir, 'b', md('b', 'ok', 'agent: explore\n'))
    writeSkill(globalDir, 'c', md('c', 'ok'))
    const loader = SkillLoader.loadAll({ globalDir })
    expect(loader.listForContext('explore').map(s => s.name)).toEqual(['b', 'c'])
    expect(loader.listForContext('default').map(s => s.name)).toEqual(['c'])
  })

  it('third_party_claude 优先级介于 builtin 与 global 之间', () => {
    writeSkill(builtinDir, 'shared', md('shared', 'builtin'))
    writeSkill(globalDir, 'shared', md('shared', 'global'))
    const thirdDir = join(tmpdir(), `nova-third-${Date.now()}`)
    mkdirSync(thirdDir, { recursive: true })
    writeSkill(thirdDir, 'shared', md('shared', 'third'))
    writeSkill(thirdDir, 'claude-only', md('claude-only', 'claude'))

    const loader = SkillLoader.loadAll({ builtinDir, globalDir, thirdPartyDir: thirdDir })
    expect(loader.get('shared')?.description).toBe('global')
    expect(loader.get('claude-only')?.source).toBe('third_party_claude')
    expect(loader.getShadowed()['shared']).toBe('third_party_claude')

    rmSync(thirdDir, { recursive: true, force: true })
  })

  it('listUserInvocable 过滤 user-invocable', () => {
    writeSkill(globalDir, 'a', md('a', 'd', 'user-invocable: false\n'))
    writeSkill(globalDir, 'b', md('b', 'ok'))
    const loader = SkillLoader.loadAll({ globalDir })
    expect(loader.listUserInvocable().map(s => s.name)).toEqual(['b'])
  })
})

describe('resolveBuiltinSkillsDir', () => {
  // 注意：首个候选 join(__dirname, '.nova', 'skills') 在 vitest 下解析到
  // src/runtime/skills/.nova/skills —— 源码树里不存在该目录，故不会误命中，
  // 各用例得以单独验证 getAppPath 候选与 dev 兜底分支。
  // 打包态下 __dirname = app.asar/out/main/，资源由 copyNovaBuiltinSkills
  // 复制到 out/main/.nova/skills，此候选直接命中（无法在单测里模拟 asar 环境）。

  it('getAppPath 候选命中：根下直接挂 .nova/skills 时返回该目录', () => {
    const appRoot = join(tmpdir(), `nova-resolve-app-${Date.now()}`)
    const appBuiltin = join(appRoot, '.nova', 'skills')
    mkdirSync(appBuiltin, { recursive: true })
    try {
      const resolved = resolveBuiltinSkillsDir(() => appRoot)
      expect(resolved).toBe(appBuiltin)
    } finally {
      rmSync(appRoot, { recursive: true, force: true })
    }
  })

  it('dev 兜底：无 getAppPath 时回退到 process.cwd()/.nova/skills', () => {
    // 源码树下 __dirname 候选不存在（见上注释），且不传 getAppPath → 走兜底
    const expected = resolveDevBuiltinDir()
    const resolved = resolveBuiltinSkillsDir()
    expect(resolved).toBe(expected)
    expect(resolved).toBe(join(process.cwd(), '.nova', 'skills'))
  })

  it('getAppPath 候选不存在时回退到 dev 路径，不返回无效路径', () => {
    // getAppPath 指向一个不存在的临时目录（其下无 .nova/skills）
    const ghostAppPath = join(tmpdir(), `nova-ghost-${Date.now()}`)
    const resolved = resolveBuiltinSkillsDir(() => ghostAppPath)
    // 不应返回 ghostAppPath/.nova/skills（该路径不存在）
    expect(resolved).not.toBe(join(ghostAppPath, '.nova', 'skills'))
    // 应回退到 dev 兜底路径
    expect(resolved).toBe(resolveDevBuiltinDir())
  })
})
