/**
 * 首次使用闭环：干净 profile → 真实设置 UI 配错 Key → 401 失败可见 →
 * 改回正确 Key → Agent 写文件并跑 node 脚本（非零退出码输出可见）。
 * 模型服务商只替换 HTTP 边界，配置与发送全走真实 UI/IPC。
 */
import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { launchNova } from '../fixtures/nova'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { SETTINGS_SET, WORKSPACE_SELECT_PROJECT } from '../../../src/shared/ipc/channels'
import type { Page } from '@playwright/test'

const GOOD_KEY = 'nova-e2e-good-key'

/** 设置里把自定义服务商改成给定 key 并保存 */
async function configureProviderKey(
  page: Page,
  baseUrl: string,
  apiKey: string
): Promise<void> {
  await page.getByRole('button', { name: '设置' }).click()
  await page.getByRole('tab', { name: '模型' }).click()
  const customCard = page.locator('.settings-split__item').filter({ hasText: '自定义服务商' })
  if (await customCard.count() === 0) {
    await page.getByRole('button', { name: /添加自定义服务商/ }).click()
  } else {
    await customCard.first().click()
  }
  await page.getByLabel('接口地址 (Base URL)').fill(baseUrl)
  await page.getByRole('textbox', { name: 'API Key', exact: true }).fill(apiKey)
  await page.getByPlaceholder('手动输入模型 ID').fill('nova-e2e-model')
  const hasModel = await page.locator('.llm-model-list li').filter({ hasText: 'nova-e2e-model' }).count()
  if (hasModel === 0) {
    await page.getByRole('button', { name: '添加模型', exact: true }).click()
  }
  // 保存成功后设置模态框自动关闭
  await page.getByRole('button', { name: '保存配置' }).click()
  await expect(page.getByRole('button', { name: '返回应用' })).toBeHidden()
}

/** 重开设置确认自定义服务商卡片显示「已配置」 */
async function expectProviderConfigured(page: Page): Promise<void> {
  await page.getByRole('button', { name: '设置' }).click()
  await page.getByRole('tab', { name: '模型' }).click()
  const card = page
    .locator('.settings-split__item')
    .filter({ hasText: '自定义服务商' })
    .filter({ hasText: '已配置' })
  await expect(card.first()).toBeVisible()
  await page.getByRole('button', { name: '返回应用' }).click()
}

test('干净 profile 经设置 UI 配置模型：错 Key 401 → 修正后写文件并跑脚本', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const nodeAvailable = (() => {
    try { execFileSync('node', ['--version'], { stdio: 'ignore' }); return true } catch { return false }
  })()
  test.skip(!nodeAvailable, '本机未检测到 node，无法验证 bash 跑 node 脚本')

  const nova = await launchNova(testInfo, { skipWorkspaceSetup: true })
  try {
  nova.provider.setExpectedApiKey(GOOD_KEY)

  // 真实设置 UI：错误 Key → 保存后卡片显示「已配置」
  await configureProviderKey(nova.page, nova.provider.baseUrl, 'nova-e2e-wrong-key')
  await expectProviderConfigured(nova.page)

  // 工作区按既有类型化 IPC 选择；权限设 auto 避免 bash 审批打断
  await nova.invoke(SETTINGS_SET, { defaultPermissionMode: 'auto' })
  await nova.invoke(WORKSPACE_SELECT_PROJECT, { path: nova.workspacePath })

  // 错 Key：模型请求被 fake 打回 401，UI 出现错误、run 失败、输入框仍可用
  await nova.sendPrompt('你好')
  // 界面出现明确错误、run 进入失败终态、输入框仍可用
  await expect(
    nova.page.getByText('API Key 不对或已失效，请到设置里检查服务商配置。')
  ).toBeVisible()
  const failed = await nova.getRunSnapshot()
  expect(failed?.status).toBe('failed')
  expect(failed?.terminalReason).toContain('401')
  expect(nova.provider.requests[0]?.authorization).toBe('Bearer nova-e2e-wrong-key')
  await expect(nova.page.getByLabel('消息输入')).toBeEditable()

  // 改回正确 Key
  await configureProviderKey(nova.page, nova.provider.baseUrl, GOOD_KEY)

  // 正确 Key：write 建脚本 → bash 以非零退出码运行它 → 结束
  const relPath = 'hello.js'
  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'write',
      arguments: {
        path: relPath,
        content: 'console.log("NOVA_E2E_SCRIPT_OUT"); process.exit(2)\n'
      },
      callId: 'call_write_e2e'
    },
    {
      kind: 'tool',
      name: 'bash',
      arguments: { command: 'node hello.js', description: '运行脚本' },
      callId: 'call_bash_e2e'
    },
    { kind: 'text', text: 'NOVA_E2E_FIRST_RUN_DONE' }
  )
  await nova.sendPrompt('写一个 hello.js 并运行它')
  await expect(nova.page.getByText('NOVA_E2E_FIRST_RUN_DONE', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()

  // 文件真实存在；展开 bash 工具行可见输出与非零退出码
  expect(existsSync(join(nova.workspacePath, relPath))).toBe(true)
  // 工具轨迹默认收在「已工作 X 秒」折叠头里，先展开再定位 bash 行
  await nova.page.locator('.turn-process-tree__header').last().click()
  const bashRow = nova.page.locator('.tool-trace-row').filter({ hasText: 'node hello.js' }).first()
  await bashRow.locator('.tool-trace-row__header').click()
  await expect(bashRow.locator('.tool-trace-row__pre').last()).toContainText('NOVA_E2E_SCRIPT_OUT')
  await expect(bashRow.locator('.tool-trace-row__pre').last()).toContainText(/命令退出码: [1-9]/)
  } finally {
    await nova.cleanup()
  }
})
