/**
 * 中断与恢复关键路径 E2E
 *
 * 覆盖的回归：
 * - 运行中进程退出后，重启对账把 run 收敛为 interrupted（工具块不再转圈），「继续分析」
 *   代发新消息开新轮次
 * - 挂起的权限请求在启动对账时收敛为已取消，不再残留「等待你处理」徽标
 * - 轮次失败/中断后，落盘工具块为终态：重载后仍是终态而非永久执行中
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { RUN_LIST_WAITING } from '../../../src/shared/ipc/channels'
import { expect, launchNova, test, type NovaHarness } from '../fixtures/nova'

const CONTINUE_PROMPT = '请从中断处继续完成刚才的任务。'

/** 关闭主进程（不取消运行），保证 run 以非终态落盘供下次启动对账 */
async function quitAppWithoutCancelling(app: ElectronApplication): Promise<void> {
  const proc = app.process()
  const closed = app.waitForEvent('close', { timeout: 30_000 }).catch(() => undefined)
  // 走真实退出路径（will-quit 落盘后 exit），复用同 profile 不会残留单实例锁
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined)
  await app.close().catch(() => undefined)
  await closed
  // 兜底：优雅退出未完成则强杀进程
  try {
    proc.kill()
  } catch {
    // 应用已关闭，进程句柄失效
  }
  // 等进程句柄与单实例锁完全释放，再启动下一实例
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && proc.exitCode === null) {
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  await new Promise(resolve => setTimeout(resolve, 1_000))
}

async function relaunchSameProfile(
  testInfo: Parameters<typeof launchNova>[0],
  nova: NovaHarness
): Promise<NovaHarness> {
  return launchNova(testInfo, {}, {
    profileRoot: nova.profileRoot,
    workspacePath: nova.workspacePath,
    provider: nova.provider
  })
}

test('运行中退出重启后按中断终态恢复，「继续分析」代发新消息开新轮次', async ({ nova }, testInfo) => {
  const state = await nova.createSession('default')
  const sessionId = state.currentSessionId
  if (!sessionId) throw new Error('session id missing')

  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'write',
      arguments: { path: 'interrupt-target.txt', content: 'nova e2e interrupt' },
      callId: 'call_write_first'
    },
    { kind: 'hold', id: 'interrupt-hold', text: 'SHOULD_NOT_COMPLETE' }
  )

  await nova.sendPrompt('执行一个会被中断的任务')
  await nova.provider.waitForRequestCount(2)
  await expect(nova.page.getByRole('button', { name: '中断生成' })).toBeVisible()
  await expect(nova.page.locator('.tool-trace-row').filter({ hasText: 'interrupt-target.txt' }))
    .toBeVisible()

  // 进程退出：不取消运行，run 保持非终态落盘
  await quitAppWithoutCancelling(nova.app)

  const resumed = await relaunchSameProfile(testInfo, nova)
  try {
    await resumed.selectSession(sessionId)

    // 启动对账：run 收敛为 interrupted，中断横幅出现
    await expect(resumed.page.getByText('上次任务异常中断', { exact: false })).toBeVisible()
    await expect(resumed.page.getByRole('button', { name: '继续分析' })).toBeVisible()
    await expect.poll(async () => (await resumed.getRunSnapshot(sessionId))?.status)
      .toBe('interrupted')

    // 工具块为终态（成功落盘）而非转圈，输入可继续使用
    await expect(resumed.page.locator('.tool-trace-row--live')).toHaveCount(0)
    await expect(resumed.page.getByRole('button', { name: '中断生成' })).toHaveCount(0)
    await expect(resumed.page.getByLabel('消息输入')).toBeEditable()
    expect(await readFile(path.join(nova.workspacePath, 'interrupt-target.txt'), 'utf8'))
      .toContain('nova e2e interrupt')

    // 「继续分析」代发新消息开新轮次
    resumed.provider.enqueue({ kind: 'text', text: 'NOVA_E2E_RECOVERED' })
    await resumed.page.getByRole('button', { name: '继续分析' }).click()

    await resumed.provider.waitForRequestCount(3)
    await expect(resumed.page.getByText(CONTINUE_PROMPT, { exact: false })).toBeVisible()
    await expect(resumed.page.getByText('NOVA_E2E_RECOVERED', { exact: false })).toBeVisible()
    await expect(resumed.page.getByRole('button', { name: '继续分析' })).toHaveCount(0)
    await resumed.waitUntilIdle()
    expect((await resumed.getRunSnapshot(sessionId))?.status).toBe('completed')

    expect(resumed.pageErrors).toEqual([])
  } finally {
    await resumed.cleanup()
  }
})

test('挂起权限请求在重启对账后收敛为已取消，不残留「等待你处理」', async ({ nova }, testInfo) => {
  const state = await nova.createSession('default')
  const sessionId = state.currentSessionId
  if (!sessionId) throw new Error('session id missing')

  nova.provider.enqueue({
    kind: 'tool',
    name: 'bash',
    arguments: { command: 'echo nova_e2e_perm' },
    callId: 'call_bash_perm'
  })

  await nova.sendPrompt('执行需要授权的命令')
  await expect.poll(async () => (await nova.getRunSnapshot(sessionId))?.status)
    .toBe('waiting_user')
  await expect(nova.page.locator('.inline-perm')).toBeVisible()

  // 当前会话处于等待视图时，「等待你处理」徽标只出现在其他会话行；
  // 先切到新会话，确认等待中的旧会话带徽标，退出后必须消失
  await expect.poll(async () => (await nova.invoke(RUN_LIST_WAITING)).length).toBe(1)
  const other = await nova.createSession('default')
  const otherId = other.currentSessionId
  if (!otherId) throw new Error('session id missing')
  await expect(nova.page.getByLabel('等待你处理')).toBeVisible()
  await nova.selectSession(sessionId)

  await quitAppWithoutCancelling(nova.app)

  const resumed = await relaunchSameProfile(testInfo, nova)
  try {
    await resumed.selectSession(sessionId)

    // 对账：run 为 interrupted，挂起权限请求已收敛为已取消，等待列表为空
    await expect(resumed.page.getByText('上次任务异常中断', { exact: false })).toBeVisible()
    await expect.poll(async () => (await resumed.getRunSnapshot(sessionId))?.status)
      .toBe('interrupted')
    await expect.poll(async () => {
      const waiting = await resumed.invoke(RUN_LIST_WAITING)
      return waiting.length
    }).toBe(0)

    // 切到其他会话视图后，旧会话不再挂「等待你处理」徽标
    await resumed.createSession('default')
    await expect(resumed.page.getByLabel('等待你处理')).toHaveCount(0)
    await resumed.selectSession(sessionId)

    // 继续分析仍可开新轮次
    resumed.provider.enqueue({ kind: 'text', text: 'NOVA_E2E_RECOVERED_AFTER_PERM' })
    await resumed.page.getByRole('button', { name: '继续分析' }).click()

    await resumed.provider.waitForRequestCount(2)
    await expect(resumed.page.getByText('NOVA_E2E_RECOVERED_AFTER_PERM', { exact: false })).toBeVisible()
    await resumed.waitUntilIdle()
    expect((await resumed.getRunSnapshot(sessionId))?.status).toBe('completed')

    expect(resumed.pageErrors).toEqual([])
  } finally {
    await resumed.cleanup()
  }
})

test('工具调用流中途失败后重载：工具块保持终态不转圈', async ({ nova }) => {
  const state = await nova.createSession('default')
  const sessionId = state.currentSessionId
  if (!sessionId) throw new Error('session id missing')

  // 第一条流仅发出工具调用增量即以 [DONE] 截止（没有完整参数/回包），
  // 随后 provider 报错：轮次以失败收尾，落盘工具块必须收敛为终态
  nova.provider.enqueue(
    {
      kind: 'raw',
      events: [
        {
          payload: {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_partial_write',
                      type: 'function',
                      function: {
                        name: 'write',
                        arguments: '{"path":'
                      }
                    }
                  ]
                },
                finish_reason: null
              }
            ]
          }
        },
        { payload: '[DONE]' }
      ]
    },
    { kind: 'error', status: 400, body: { error: { message: 'NOVA_E2E_STREAM_FAILURE' } } }
  )

  await nova.sendPrompt('触发工具调用中断')
  await expect.poll(async () => (await nova.getRunSnapshot(sessionId))?.status, { timeout: 15_000 })
    .toMatch(/^(failed|cancelled)$/)
  await nova.waitUntilIdle()

  // 轮次以失败收敛：错误文案可见，对话不残留 live 转圈行
  await expect(nova.page.getByText('NOVA_E2E_STREAM_FAILURE', { exact: false })).toBeVisible()
  await expect(nova.page.locator('.tool-trace-row--live')).toHaveCount(0)

  // 重载后：错误终态保持，无 live 转圈行、无「中断生成」，会话可继续输入
  await nova.page.reload()
  await expect(nova.page.getByLabel('消息输入')).toBeVisible()
  await expect(nova.page.locator('.tool-trace-row--live')).toHaveCount(0)
  await expect(nova.page.getByRole('button', { name: '中断生成' })).toHaveCount(0)
  await expect(nova.page.getByLabel('消息输入')).toBeEditable()
  await expect(nova.page.getByText('NOVA_E2E_STREAM_FAILURE', { exact: false })).toBeVisible()

  expect(nova.pageErrors).toEqual([])
})
