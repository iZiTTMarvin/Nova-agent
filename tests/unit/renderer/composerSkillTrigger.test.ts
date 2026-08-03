/**
 * Composer `/` trigger：选中插入纯文本，参数阶段不再由自研浮层拦截 Enter。
 *
 * 官方 useTriggerMenu 在空白边界关闭菜单；本文件锁 SearchSource 排序与 onSelect 契约。
 */
import { describe, expect, it } from 'vitest'
import { createComposerSkillTrigger } from '../../../src/renderer/features/skills/composerSkillTrigger'
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
  it('前缀查询命中技能，onSelect 插入带尾随空格的 slash 文本', async () => {
    const trigger = createComposerSkillTrigger(() => [FRONTEND_SKILL])
    const results = await trigger.searchSource.search('frontend')
    expect(results.map(r => r.label)).toEqual(['frontend-design'])

    const selected = trigger.onSelect(results[0] as ComposerSkillItem)
    expect(selected).toBe('/frontend-design ')
  })

  it('空查询返回可调用技能列表（bootstrap / search）', async () => {
    const trigger = createComposerSkillTrigger(() => [FRONTEND_SKILL])
    const boot = await trigger.searchSource.bootstrap()
    const all = await trigger.searchSource.search('')
    expect(boot).toHaveLength(1)
    expect(all).toHaveLength(1)
    expect(all[0]?.label).toBe('frontend-design')
  })

  it('无匹配时返回空列表', async () => {
    const trigger = createComposerSkillTrigger(() => [FRONTEND_SKILL])
    const results = await trigger.searchSource.search('zzz-no-match')
    expect(results).toEqual([])
  })

  it('character 为 /，用于官方 trigger 菜单', () => {
    const trigger = createComposerSkillTrigger(() => [FRONTEND_SKILL])
    expect(trigger.character).toBe('/')
  })
})
