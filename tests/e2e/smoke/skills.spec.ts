import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WORKSPACE_SELECT_PROJECT } from '../../../src/shared/ipc/channels'
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

async function openSkills(nova: NovaHarness): Promise<void> {
  await nova.page.getByRole('button', { name: '设置' }).click()
  await nova.page.getByRole('tab', { name: '技能' }).click()
  await expect(nova.page.getByRole('button', { name: '刷新列表' })).toBeVisible()
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

test('无效 slash 在发送边界本地拒绝：保留草稿并展示原因', async ({ nova }) => {
  const input = nova.page.getByLabel('消息输入')
  await input.fill('/e2e-typo-xyz')
  await nova.page.getByRole('button', { name: '发送' }).click()

  await expect(nova.page.getByText(/未找到技能 \/e2e-typo-xyz/)).toBeVisible()
  await expect(input).toContainText('/e2e-typo-xyz')
  await expect(nova.page.getByLabel('消息输入')).toBeEditable()
  expect(nova.pageErrors).toEqual([])
})

test('设置页可启停、删除项目技能，非 https 导入给出明确错误', async ({ nova }) => {
  await writeProjectSkill(nova.workspacePath, 'e2e-toggle', 'E2E 启停技能')
  await openSkills(nova)
  await nova.page.getByRole('button', { name: '刷新列表' }).click()

  const card = nova.page.locator('.skill-card', { hasText: 'e2e-toggle' })
  await expect(card).toBeVisible()

  const toggle = card.locator('input[type="checkbox"]')
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect.poll(async () => {
    const snapshot = await nova.invoke('skill:list')
    return snapshot.skills.find(s => s.name === 'e2e-toggle')?.enabled
  }).toBe(false)

  nova.page.once('dialog', dialog => void dialog.accept())
  await card.getByRole('button', { name: '删除' }).click()
  await expect(nova.page.getByText('已删除技能「e2e-toggle」')).toBeVisible()
  await expect.poll(async () => {
    const snapshot = await nova.invoke('skill:list')
    return snapshot.skills.some(s => s.name === 'e2e-toggle')
  }).toBe(false)

  await nova.page.getByRole('button', { name: '导入' }).click()
  await nova.page.getByPlaceholder('https://example.com/skill.zip').fill('http://127.0.0.1:9/nope.zip')
  await nova.page.getByRole('button', { name: '从 URL 导入' }).click()
  await expect(nova.page.locator('.settings-panel__status--error')).toContainText('仅支持 https')
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
