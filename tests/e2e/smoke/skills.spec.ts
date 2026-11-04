import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SAVE_MODEL_CONFIG, WORKSPACE_SELECT_PROJECT } from '../../../src/shared/ipc/channels'
import { expect, test, type NovaHarness } from '../fixtures/nova'
import type { Locator } from '@playwright/test'

const SKILL_MD = (name: string, desc: string) =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`

async function writeProjectSkill(workspacePath: string, name: string, desc: string): Promise<void> {
  const dir = path.join(workspacePath, '.nova', 'skills', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'SKILL.md'), SKILL_MD(name, desc), 'utf8')
}

async function reloadRenderer(nova: NovaHarness): Promise<void> {
  await nova.page.reload()
  await nova.page.waitForFunction(() => Boolean((window as typeof window & { api?: unknown }).api))
  await expect(nova.page.getByLabel('消息输入')).toBeVisible()
}

async function expectSkillChip(input: Locator, name: string): Promise<void> {
  const chip = input.locator('[data-astryx-token]')
  await expect(chip).toHaveCount(1)
  await expect(chip).toHaveAttribute('data-astryx-token-value', `/${name}`)
  await expect(chip).toContainText(`/${name}`)
}

test('/ 触发显示项目技能，点击或键盘选中后插入技能芯片；无匹配显示空态', async ({ nova }) => {
  await writeProjectSkill(nova.workspacePath, 'e2e-demo', 'E2E 演示技能')
  await reloadRenderer(nova)

  const input = nova.page.getByLabel('消息输入')
  await input.fill('/e2e')
  const item = nova.page.locator('.composer-skill-trigger__item', { hasText: 'e2e-demo' })
  await expect(item).toBeVisible()
  await item.click()
  await expectSkillChip(input, 'e2e-demo')
  await expect(item).toHaveCount(0)

  await input.fill('/e2e')
  await expect(item).toBeVisible()
  await input.press('Enter')
  await expectSkillChip(input, 'e2e-demo')

  await input.fill('/zzzz-no-such-skill')
  await expect(nova.page.getByText('没有匹配的技能')).toBeVisible()
  expect(nova.pageErrors).toEqual([])
})

test('+ 菜单展示技能与命令入口，空草稿写入 / 打开同一份目录', async ({ nova }) => {
  await nova.page.getByRole('button', { name: '添加工作流、上下文与工具' }).click()
  const entry = nova.page.getByRole('menuitem', { name: '技能与命令' })
  await expect(entry).toBeVisible()
  await entry.click()
  await expect(nova.page.getByLabel('消息输入')).toContainText('/')
  expect(nova.pageErrors).toEqual([])
})

test('原生命令与技能同列，/plan 切换模式并刷新持久化回执', async ({ nova }) => {
  const input = nova.page.getByLabel('消息输入')
  await input.fill('/')

  const commandGroup = nova.page.locator('[role="group"][aria-label="命令"]')
  const commandItems = commandGroup.locator('.composer-skill-trigger__item')
  await expect(commandItems).toHaveCount(3)
  for (const name of ['compact', 'init', 'plan']) {
    await expect(commandItems.filter({ hasText: `/${name}` })).toBeVisible()
  }

  await nova.sendPrompt('/plan')
  await expect(nova.page.getByText('已切换到规划模式。接下来将只读分析工作区并保存计划。', { exact: true })).toBeVisible()
  await expect.poll(async () => (await nova.getWorkspace()).currentMode).toBe('plan')
  await expect.poll(async () => {
    const workspace = await nova.getWorkspace()
    return workspace.availableSessions.some(session => session.id === workspace.currentSessionId)
  }).toBe(true)
  expect(await nova.getRunSnapshot()).toBeNull()
  await expect(input).toBeEditable()
  expect(nova.pageErrors).toEqual([])
})

test('/compact 在空会话完成真实 durable run，且不调用模型', async ({ nova }) => {
  await nova.sendPrompt('/compact')

  await expect(nova.page.getByText('当前没有可压缩的上下文。', { exact: true })).toBeVisible()
  await nova.waitUntilIdle()
  expect((await nova.getRunSnapshot())?.status).toBe('completed')
  expect(nova.provider.requests).toHaveLength(0)
  expect(nova.pageErrors).toEqual([])
})

test('/compact 提交真实压缩账本，后续模型请求使用摘要而非被折叠原文', async ({ nova }) => {
  test.setTimeout(90_000)
  await nova.invoke(SAVE_MODEL_CONFIG, {
    baseUrl: nova.provider.baseUrl,
    apiKey: 'nova-e2e-key',
    modelId: 'nova-e2e-model',
    cacheProfile: 'generic',
    toolDialect: 'native',
    contextWindow: 65_536
  })
  await reloadRenderer(nova)

  for (let index = 0; index < 10; index++) {
    const marker = `OLD_HISTORY_${index}`
    nova.provider.enqueue({ kind: 'text', text: `${marker} ${'x'.repeat(5_000)}` })
    await nova.sendPrompt(`历史记录 ${index}`)
    await expect(nova.page.getByText(marker, { exact: false })).toBeVisible()
    await nova.waitUntilIdle()
  }
  expect(nova.provider.requests).toHaveLength(10)

  nova.provider.enqueue(
    { kind: 'text', text: '历史摘要：十轮旧对话已折叠。\nanchor-old' },
    {
      kind: 'text',
      text: JSON.stringify({
        schemaVersion: 1,
        goal: '压缩后的工作状态',
        nextActions: '继续任务',
        keyContext: '(none)',
        progress: '(none)',
        decisions: '(none)',
        facts: []
      })
    },
    { kind: 'text', text: 'NOVA_E2E_AFTER_COMPACT' }
  )

  await nova.sendPrompt('/compact')
  await expect(nova.page.getByText('当前会话上下文已压缩。', { exact: true })).toBeVisible()
  await nova.waitUntilIdle()
  expect((await nova.getRunSnapshot())?.status).toBe('completed')
  expect(nova.provider.requests).toHaveLength(12)

  await nova.sendPrompt('继续')
  await expect(nova.page.getByText('NOVA_E2E_AFTER_COMPACT', { exact: true })).toBeVisible()
  await nova.waitUntilIdle()
  const resumedRequest = JSON.stringify(nova.provider.requests.at(-1)?.body ?? {})
  expect(resumedRequest).toContain('历史摘要：十轮旧对话已折叠。')
  expect(resumedRequest).toContain('压缩后的工作状态')
  expect(resumedRequest).not.toContain('OLD_HISTORY_0')
  expect(nova.pageErrors).toEqual([])
})

test('/init 将展开指令送入真实 Agent，并只生成工作区根 AGENTS.md', async ({ nova }) => {
  const rules = '# 项目协作约定\n\n- 保留现有测试说明。\n- 使用真实工作区命令验证。\n'
  nova.provider.enqueue(
    { kind: 'tool', name: 'ls', arguments: { path: '.' }, callId: 'call_init_ls' },
    { kind: 'tool', name: 'write', arguments: { path: 'AGENTS.md', content: rules }, callId: 'call_init_write' },
    { kind: 'text', text: 'NOVA_E2E_INIT_OK' }
  )

  await nova.sendPrompt('/init 保留现有测试说明')
  await nova.provider.waitForRequestCount(3)
  await expect(nova.page.getByText('NOVA_E2E_INIT_OK', { exact: true })).toBeVisible()
  await nova.waitUntilIdle()

  const firstRequest = JSON.stringify(nova.provider.requests[0]?.body ?? {})
  expect(firstRequest).toContain('只能创建或更新工作区根目录的 AGENTS.md')
  expect(firstRequest).toContain('保留现有测试说明')
  expect(await readFile(path.join(nova.workspacePath, 'AGENTS.md'), 'utf8')).toBe(rules)
  expect((await nova.getRunSnapshot())?.status).toBe('completed')
  expect(nova.pageErrors).toEqual([])
})

test('无效 slash 在发送边界本地拒绝：保留草稿并展示原因', async ({ nova }) => {
  const input = nova.page.getByLabel('消息输入')
  await input.fill('/e2e-typo-xyz')
  await nova.page.getByRole('button', { name: '发送' }).click()

  await expect(nova.page.getByText(/未找到技能 \/e2e-typo-xyz/)).toBeVisible()
  await expect(input).toContainText('/e2e-typo-xyz')
  await expect(nova.page.getByLabel('消息输入')).toBeEditable()
  expect(nova.pageErrors).toEqual([])
})

test('技能可导出为 zip，切换工作区后目录跟随新项目', async ({ nova }, testInfo) => {
  await writeProjectSkill(nova.workspacePath, 'e2e-export', 'E2E 导出技能')
  await nova.invoke('skill:reload', nova.workspacePath)

  const zipDest = testInfo.outputPath('e2e-export.zip')
  const exported = await nova.invoke('skill:export', { name: 'e2e-export', destPath: zipDest })
  expect(exported.canceled).toBe(false)
  expect(exported.zipPath).toBeDefined()
  expect(existsSync(exported.zipPath!)).toBe(true)
  expect(statSync(exported.zipPath!).size).toBeGreaterThan(0)

  const workspace2 = await mkdtemp(path.join(os.tmpdir(), 'nova-e2e-workspace2-'))
  try {
    await writeProjectSkill(workspace2, 'e2e-ws2', 'E2E 第二工作区技能')
    await nova.invoke(WORKSPACE_SELECT_PROJECT, { path: workspace2 })
    await reloadRenderer(nova)

    const snapshot = await nova.invoke('skill:list')
    const names = snapshot.skills.map(s => s.name)
    expect(names).toContain('e2e-ws2')
    expect(names).not.toContain('e2e-export')

    const input = nova.page.getByLabel('消息输入')
    await input.fill('/e2e-ws2')
    await expect(
      nova.page.locator('.composer-skill-trigger__item', { hasText: 'e2e-ws2' })
    ).toBeVisible()
    await input.fill('/e2e-export')
    await expect(nova.page.getByText('没有匹配的技能')).toBeVisible()
  } finally {
    await rm(workspace2, { recursive: true, force: true })
  }
  expect(nova.pageErrors).toEqual([])
})
