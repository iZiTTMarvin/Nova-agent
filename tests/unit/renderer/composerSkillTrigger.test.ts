/**
 * Composer `/` trigger：选中插入行内芯片，参数阶段不再由自研浮层拦截 Enter。
 *
 * 官方 useTriggerMenu 在空白边界关闭菜单；本文件锁 SearchSource 排序与 onSelect 契约。
 */
import { describe, expect, it } from 'vitest'
import {
  createComposerSkillTrigger,
  skillComposerToken
} from '../../../src/renderer/features/skills/composerSkillTrigger'
import type { SkillSummary } from '../../../src/shared/skills/types'
import type { ComposerSkillItem } from '../../../src/renderer/features/skills/composerSkillTrigger'

const FRONTEND_SKILL: SkillSummary = {
  name: 'frontend-design',
  description: '前端设计',
  source: 'builtin',
  sourcePath: '',
  userInvocable: true,
  modelInvocable: true,
  enabled: true,
  invalid: false,
  warnings: [],
  bodyPreview: '',
  hasSupportingFiles: false
}

describe('createComposerSkillTrigger', () => {
  it('前缀查询命中技能，onSelect 插入序列化为 slash 的行内芯片', async () => {
    const trigger = createComposerSkillTrigger(() => [FRONTEND_SKILL])
    const results = await trigger.searchSource.search('frontend')
    expect(results.map(r => r.label)).toEqual(['frontend-design'])

    const selected = trigger.onSelect(results[0] as ComposerSkillItem)
    expect(selected).toEqual(skillComposerToken('frontend-design'))
  })

  it('空查询在 bootstrap 与 search 中均将命令排在技能前', async () => {
    const trigger = createComposerSkillTrigger(() => [FRONTEND_SKILL])
    const boot = await trigger.searchSource.bootstrap()
    const all = await trigger.searchSource.search('')
    const expected = ['compact', 'init', 'plan', 'frontend-design']
    expect(boot.map(item => item.label)).toEqual(expected)
    expect(all.map(item => item.label)).toEqual(expected)
  })

  it('候选写入官方菜单分组字段，搜索时命令组仍整体排在技能组前', async () => {
    // planner 前缀分高于 plan 命令（skill 同名加权），分组后顺序仍以命令组为先
    const trigger = createComposerSkillTrigger(() => [
      { ...FRONTEND_SKILL, name: 'planner' }
    ])
    const results = (await trigger.searchSource.search('plan')) as ComposerSkillItem[]
    expect(results.map(item => item.label)).toEqual(['plan', 'planner'])
    expect(results.map(item => item.auxiliaryData.group)).toEqual(['命令', '技能'])
  })

  it('无技能时仍返回三个命令，选中 /init 只序列化命令本身', async () => {
    const trigger = createComposerSkillTrigger(() => [])
    const boot = await trigger.searchSource.bootstrap()
    const all = await trigger.searchSource.search('')
    expect(boot.map(item => item.label)).toEqual(['compact', 'init', 'plan'])
    expect(all.map(item => item.label)).toEqual(['compact', 'init', 'plan'])

    const init = all.find(item => item.label === 'init') as ComposerSkillItem
    expect(init.auxiliaryData.kind).toBe('command')
    expect(trigger.onSelect(init)).toEqual({
      value: '/init',
      label: '/init',
      variant: 'yellow'
    })
  })

  it('无匹配时返回空列表，空态同时涵盖技能与命令', async () => {
    const trigger = createComposerSkillTrigger(() => [FRONTEND_SKILL])
    const results = await trigger.searchSource.search('zzz-no-match')
    expect(results).toEqual([])
    expect(trigger.emptySearchResultsText).toBe('没有匹配的技能或命令')
  })

  it('character 为 /，菜单文案为技能与命令', () => {
    const trigger = createComposerSkillTrigger(() => [FRONTEND_SKILL])
    expect(trigger.character).toBe('/')
    expect(trigger.menuLabel).toBe('技能与命令')
  })

  it('pilot 模式无可用技能时展示「选择技能…」引导，选中唤起设置且返回空串', async () => {
    let opened = false
    const trigger = createComposerSkillTrigger(() => [], {
      getMode: () => 'pilot',
      onOpenPilotSettings: () => {
        opened = true
      }
    })
    const boot = await trigger.searchSource.bootstrap()
    const labels = boot.map(item => item.label)
    expect(labels).toEqual(['compact', 'init', 'plan', '选择技能…'])

    const selectAction = boot.find(item => item.label === '选择技能…') as ComposerSkillItem
    expect(selectAction).toBeDefined()
    expect(selectAction.auxiliaryData.isAction).toBe(true)

    const result = trigger.onSelect(selectAction)
    expect(result).toBe('')
    expect(opened).toBe(true)
  })

  it('pilot 模式有已许可技能时末尾追加「管理可用技能…」动作项', async () => {
    let opened = false
    const trigger = createComposerSkillTrigger(() => [FRONTEND_SKILL], {
      getMode: () => 'pilot',
      onOpenPilotSettings: () => {
        opened = true
      }
    })
    const boot = await trigger.searchSource.bootstrap()
    const labels = boot.map(item => item.label)
    expect(labels).toEqual(['compact', 'init', 'plan', 'frontend-design', '管理可用技能…'])

    const manageAction = boot.find(item => item.label === '管理可用技能…') as ComposerSkillItem
    expect(manageAction).toBeDefined()
    expect(manageAction.auxiliaryData.isAction).toBe(true)

    const result = trigger.onSelect(manageAction)
    expect(result).toBe('')
    expect(opened).toBe(true)
  })
})
