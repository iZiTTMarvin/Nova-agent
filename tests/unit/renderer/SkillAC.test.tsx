/**
 * SkillAC 交互层回归测试
 *
 * 覆盖「选中 skill 后输入参数能正常发送」修复：
 * 当输入进入参数阶段（出现空白字符）后，`/` 自动补全浮层关闭，
 * Enter/Tab 不再被拦截、不再把输入框重置回 "/skillname "。
 *
 * 修复前：输入 "/frontend-design 做一个登录页" 再按 Enter，
 *        浮层仍 open，Enter 被拦截并把 inputVal 重置为 "/frontend-design "，
 *        参数丢失、消息发不出去。
 */
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { SkillAC, type SkillACHandle } from '../../../src/renderer/features/skills/SkillAC'
import type { SkillSummary } from '../../../src/shared/skills/types'

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
  bodyPreview: ''
}

/** 构造最小可用的 KeyboardEvent，仅 onKeyDown 用到 key 与 preventDefault */
function keyEvent(key: string): React.KeyboardEvent {
  return {
    key,
    preventDefault: vi.fn()
  } as unknown as React.KeyboardEvent
}

/**
 * 渲染 SkillAC 并取回其通过 ref 暴露的 onKeyDown。
 * 测试环境无 document，浮层 Portal 分支会 early return，但 hooks 与
 * useImperativeHandle 正常执行，onKeyDown 行为可被验证。
 */
async function renderSkillAC(inputValue: string): Promise<{
  onKeyDown: (e: React.KeyboardEvent) => boolean
  onSelect: ReturnType<typeof vi.fn>
}> {
  const onSelect = vi.fn()
  let handle: SkillACHandle | null = null
  const anchorRef = { current: null as HTMLElement | null }

  await act(async () => {
    TestRenderer.create(
      React.createElement(SkillAC, {
        ref: (h: SkillACHandle | null) => {
          handle = h
        },
        inputValue,
        anchorRef,
        skills: [FRONTEND_SKILL],
        onSelect
      })
    )
  })

  return {
    onKeyDown: (e: React.KeyboardEvent) => handle!.onKeyDown(e),
    onSelect
  }
}

describe('SkillAC 浮层关闭逻辑（参数阶段不拦截 Enter）', () => {
  it('输入纯 slash 命令（无空白）时，Enter 选中候选并拦截', async () => {
    const { onKeyDown, onSelect } = await renderSkillAC('/frontend')
    const e = keyEvent('Enter')

    const handled = onKeyDown(e)

    expect(handled).toBe(true)
    expect(e.preventDefault).toHaveBeenCalled()
    // 选中后输入框应被替换为 "/skillname "（带尾随空格，便于直接接参数）
    expect(onSelect).toHaveBeenCalledWith('/frontend-design ')
  })

  it('选中后输入框出现尾随空格时，Enter 不再拦截（回归发送路径）', async () => {
    const { onKeyDown, onSelect } = await renderSkillAC('/frontend-design ')
    const e = keyEvent('Enter')

    const handled = onKeyDown(e)

    expect(handled).toBe(false)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('选中后在 slash 命令后追加参数时，Enter 不拦截、不重置输入框', async () => {
    // 这是用户实际踩坑的场景："/frontend-design 做一个登录页" 后回车想发送
    const { onKeyDown, onSelect } = await renderSkillAC('/frontend-design 做一个登录页')
    const e = keyEvent('Enter')

    const handled = onKeyDown(e)

    expect(handled).toBe(false)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('换行进入参数阶段同样关闭浮层（多行输入）', async () => {
    const { onKeyDown, onSelect } = await renderSkillAC('/frontend-design\n做一个登录页')
    const e = keyEvent('Enter')

    const handled = onKeyDown(e)

    expect(handled).toBe(false)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('Tab 在参数阶段同样不触发选中', async () => {
    const { onKeyDown, onSelect } = await renderSkillAC('/frontend-design 做一个登录页')
    const e = keyEvent('Tab')

    const handled = onKeyDown(e)

    expect(handled).toBe(false)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('纯 slash 命令阶段 Tab 仍可选中（保持原有快捷键能力）', async () => {
    const { onKeyDown, onSelect } = await renderSkillAC('/frontend')
    const e = keyEvent('Tab')

    const handled = onKeyDown(e)

    expect(handled).toBe(true)
    expect(onSelect).toHaveBeenCalledWith('/frontend-design ')
  })
})
