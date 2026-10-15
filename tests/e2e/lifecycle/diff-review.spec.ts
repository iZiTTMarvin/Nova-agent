import { expect, test } from '../fixtures/nova'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * 拒绝改动与用户后续编辑冲突时的保护链路：
 * agent 写文件 → 用户在外部又改 → 点拒绝 → 摘要不一致，UI 提示且文件不被覆盖；
 * diff 重拉后再点拒绝 → 恢复 checkpoint 里的原始内容。
 */
test('查看 diff 后文件又被修改时拒绝被拦下，刷新后可正常恢复', async ({ nova }) => {
  const relPath = 'reject-me.txt'
  const target = path.join(nova.workspacePath, relPath)
  await writeFile(target, 'ORIGINAL_CONTENT\n', 'utf8')

  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'write',
      arguments: { path: relPath, content: 'AGENT_EDITED\n' },
      callId: 'call_reject_e2e'
    },
    { kind: 'text', text: 'NOVA_E2E_REJECT_DONE' }
  )

  await nova.sendPrompt('把 reject-me.txt 改写一下')
  await nova.provider.waitForRequestCount(2)
  await expect(nova.page.getByText('NOVA_E2E_REJECT_DONE', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()
  expect(await readFile(target, 'utf8')).toBe('AGENT_EDITED\n')

  const filePanel = nova.page.locator('.diff-file').filter({ hasText: relPath })
  await expect(filePanel).toBeVisible()

  // 用户审阅 diff 期间在外部又改了同一文件
  await writeFile(target, 'USER_LATER_EDIT\n', 'utf8')
  await filePanel.locator('.diff-action-btn--reject').click()

  // UI 显示冲突错误，工作区文件仍是用户的修改
  await expect(filePanel.locator('.diff-file__error')).toBeVisible()
  await expect(filePanel.locator('.diff-file__error')).toContainText('又被修改')
  expect(await readFile(target, 'utf8')).toBe('USER_LATER_EDIT\n')

  // 缓存重拉后摘要已更新，再次拒绝应恢复 checkpoint 备份
  await filePanel.locator('.diff-action-btn--reject').click()
  await expect.poll(async () => readFile(target, 'utf8')).toBe('ORIGINAL_CONTENT\n')
  expect(nova.pageErrors).toEqual([])
})

test('取消 bash 后只展示真实改动，重载与拒绝仍保留正确文件基线', async ({ nova }) => {
  const target = path.join(nova.workspacePath, 'changed.txt')
  await writeFile(target, 'ORIGINAL\n', 'utf8')
  await writeFile(path.join(nova.workspacePath, 'untouched.txt'), 'UNCHANGED\n', 'utf8')
  nova.provider.enqueue({
    kind: 'tool', name: 'bash', callId: 'cancel-diff-command',
    arguments: {
      command: 'node -e "require(\'fs\').writeFileSync(\'changed.txt\', \'AGENT_EDITED\\n\'); setTimeout(() => {}, 60000)"'
    }
  })

  await nova.sendPrompt('修改 changed.txt 后等待我停止')
  await expect.poll(async () => readFile(target, 'utf8')).toBe('AGENT_EDITED\n')
  await nova.page.getByRole('button', { name: '中断生成' }).click()
  await nova.waitUntilIdle()
  await expect(nova.page.getByText('已编辑 1 个文件', { exact: true })).toBeVisible()
  await expect(nova.page.locator('.diff-file').filter({ hasText: 'untouched.txt' })).toHaveCount(0)

  await nova.page.reload()
  await expect(nova.page.getByText('已编辑 1 个文件', { exact: true })).toBeVisible()
  const filePanel = nova.page.locator('.diff-file').filter({ hasText: 'changed.txt' })
  await filePanel.locator('.diff-action-btn--reject').click()
  await expect.poll(async () => readFile(target, 'utf8')).toBe('ORIGINAL\n')
  expect(await readFile(path.join(nova.workspacePath, 'untouched.txt'), 'utf8')).toBe('UNCHANGED\n')
  expect(nova.pageErrors).toEqual([])
})
