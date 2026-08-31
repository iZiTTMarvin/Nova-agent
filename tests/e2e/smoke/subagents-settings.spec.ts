import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, launchNova, test, type NovaHarness } from '../fixtures/nova'

async function openSubagents(nova: NovaHarness): Promise<void> {
  await nova.page.getByRole('button', { name: '设置' }).click()
  await nova.page.getByRole('tab', { name: '子 Agent' }).click()
  await expect(nova.page.getByRole('button', { name: '创建子代理' })).toBeVisible()
}

async function beginCreate(nova: NovaHarness, name: string, id?: string): Promise<void> {
  await nova.page.getByRole('button', { name: '创建子代理' }).click()
  await nova.page.getByLabel('显示名称').fill(name)
  if (id) await nova.page.getByLabel('稳定 ID').fill(id)
  await nova.page.getByRole('button', { name: '下一步' }).click()
  await expect(nova.page.getByText('步骤 2 / 2')).toBeVisible()
}

test('子代理设置通过真实 IPC 完成复制、编辑、启停和项目覆盖恢复', async ({ nova }, testInfo) => {
  await openSubagents(nova)

  await nova.page.getByLabel('explore', { exact: true }).click()
  await nova.page.getByRole('button', { name: '复制为自定义' }).click()
  await nova.page.getByRole('button', { name: '确认创建' }).click()
  await expect(nova.page.getByText('全局配置')).toBeVisible()
  await expect(nova.page.getByText('ID：')).toContainText('explore-2')

  await nova.page.getByLabel('禁用 explore 副本').click()
  await expect(nova.page.getByText('全局 · 已禁用')).toBeVisible()
  await nova.page.getByLabel('启用 explore 副本').click()

  await nova.page.getByLabel('显示名称').fill('全局探索副本')
  await nova.page.getByRole('button', { name: '保存更改' }).click()
  await expect(nova.page.getByRole('heading', { name: '全局探索副本' })).toBeVisible()

  await beginCreate(nova, '项目探索副本', 'explore-2')
  await nova.page.getByLabel('保存范围').click()
  await nova.page.getByRole('option', { name: '当前项目' }).click()
  await nova.page.getByRole('button', { name: '确认创建' }).click()
  await expect(nova.page.getByText('项目配置')).toBeVisible()

  await nova.page.getByRole('button', { name: '删除配置' }).click()
  await nova.page.getByRole('button', { name: '确认删除' }).click()
  await expect(nova.page.getByRole('heading', { name: '全局探索副本' })).toBeVisible()
  await expect(nova.page.getByText('全局配置')).toBeVisible()

  await nova.app.close()
  const resumed = await launchNova(testInfo, {}, {
    profileRoot: nova.profileRoot,
    workspacePath: nova.workspacePath,
    provider: nova.provider
  })
  try {
    await openSubagents(resumed)
    await resumed.page.getByLabel('全局探索副本', { exact: true }).click()
    await expect(resumed.page.getByText('ID：')).toContainText('explore-2')
    expect(resumed.pageErrors).toEqual([])
    expect(resumed.rendererConsole.filter(line => /Warning|unhandled/i.test(line))).toEqual([])
  } finally {
    await resumed.cleanup()
  }
})

test('无可用模型与损坏配置在真实 Electron 中可诊断，保存失败保留草稿', async ({}, testInfo) => {
  const nova = await launchNova(testInfo, { skipWorkspaceSetup: true })
  try {
    const novaHome = path.join(nova.profileRoot, 'home', '.nova')
    await mkdir(novaHome, { recursive: true })
    await writeFile(path.join(novaHome, 'subagents.json'), '{ invalid json', 'utf8')

    await openSubagents(nova)
    await expect(nova.page.getByText('部分配置无法读取')).toBeVisible()
    await beginCreate(nova, '保留草稿验证')
    await expect(nova.page.getByText('没有可用的固定模型')).toBeVisible()
    await nova.page.getByRole('button', { name: '确认创建' }).click()
    await expect(nova.page.getByText(/目标层级配置不可判定或已损坏/)).toBeVisible()
    await expect(nova.page.getByLabel('显示名称')).toHaveValue('保留草稿验证')
    await expect(nova.page.getByText('步骤 2 / 2')).toBeVisible()
    expect(nova.pageErrors).toEqual([])
    expect(nova.rendererConsole.filter(line => /Warning|unhandled/i.test(line))).toEqual([])
  } finally {
    await nova.cleanup()
  }
})
