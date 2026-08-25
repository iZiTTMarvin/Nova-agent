/**
 * 持久 shell 会话生命周期：让出后跨 turn 存活、renderer reload 不受影响、
 * 会话删除与应用退出后不留残留进程。进程存活用被测命令写下的 PID 直接判定。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type NovaHarness } from '../fixtures/nova'
import { SETTINGS_SET, WORKSPACE_DELETE_SESSION } from '../../../src/shared/ipc/channels'
import type { RecordedRequest } from '../fixtures/fake-runtime'

// 缩短前台等待边界（宿主级旋钮，非模型可见），否则每条用例都要真等默认时长。
process.env['NOVA_BASH_YIELD_BOUNDARY_MS'] = '4000'

function longRunningCommand(pidFile: string): string {
  if (process.platform === 'win32') {
    return `$PID | Set-Content -Path "${pidFile}"; Start-Sleep -Seconds 300`
  }
  return `echo $$ > "${pidFile}" && sleep 300`
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readPidFromFile(pidFile: string): Promise<number> {
  const content = await readFile(pidFile, 'utf8')
  const match = /\d+/.exec(content)
  if (!match) throw new Error(`pid file 内容异常: ${JSON.stringify(content)}`)
  return Number(match[0])
}

/** 从真实模型请求体里找 bash 让出时回灌的进程会话引用 */
function findSessionRef(requests: RecordedRequest[]): string | null {
  for (const request of requests) {
    const messages = request.body['messages']
    if (!Array.isArray(messages)) continue
    for (const message of messages) {
      const content = (message as { content?: unknown }).content
      if (typeof content !== 'string') continue
      const match = /psn_[A-Za-z0-9_-]{12}/.exec(content)
      if (match) return match[0]
    }
  }
  return null
}

async function reloadRenderer(nova: NovaHarness): Promise<void> {
  await nova.page.reload()
  await nova.page.waitForFunction(() =>
    Boolean((window as typeof window & { api?: unknown }).api)
  )
}

async function startLongTaskAndWaitForYield(
  nova: NovaHarness,
  pidFile: string
): Promise<number> {
  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'bash',
      arguments: { command: longRunningCommand(pidFile), description: 'e2e 长任务' }
    },
    { kind: 'text', text: 'TASK_YIELDED' }
  )
  await nova.sendPrompt('启动一个长任务')
  await expect(nova.page.getByText('TASK_YIELDED')).toBeVisible()
  await nova.waitUntilIdle()
  return readPidFromFile(pidFile)
}

test('长任务让出后跨 turn 与 reload 存活，删除会话后无残留进程', async ({ nova }) => {
  test.setTimeout(150_000)
  await nova.invoke(SETTINGS_SET, { permissionPolicy: 'auto' })

  const pidFile = join(nova.workspacePath, 'nova-e2e-pid.txt')
  const pid = await startLongTaskAndWaitForYield(nova, pidFile)
  expect(isPidAlive(pid)).toBe(true)

  // 进程注册表在主进程：renderer 重复 reload 不得影响存活与后续交互
  await reloadRenderer(nova)
  await reloadRenderer(nova)
  expect(isPidAlive(pid)).toBe(true)

  // 从真实模型请求里拿 ref，让下一轮模型调用 shell_session read（完整走一遍协议链）
  const ref = findSessionRef(nova.provider.requests)
  expect(ref).not.toBeNull()
  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'shell_session',
      arguments: { ref: ref ?? '', action: 'read' }
    },
    { kind: 'text', text: 'READ_DONE' }
  )
  await nova.sendPrompt('看看长任务现在怎么样了')
  await expect(nova.page.getByText('READ_DONE')).toBeVisible()
  await nova.waitUntilIdle()
  // 上一轮 run 已完成、进程仍存活——这就是跨 turn 存活
  expect(isPidAlive(pid)).toBe(true)

  const workspace = await nova.getWorkspace()
  const sessionId = workspace.currentSessionId
  expect(sessionId).not.toBeNull()
  await nova.invoke(WORKSPACE_DELETE_SESSION, { sessionId: sessionId ?? '' })

  await expect
    .poll(() => isPidAlive(pid), { timeout: 20_000 })
    .toBe(false)
  expect(nova.pageErrors).toEqual([])
})

test('应用退出路径走完后无残留子进程', async ({ nova }) => {
  test.setTimeout(150_000)
  await nova.invoke(SETTINGS_SET, { permissionPolicy: 'auto' })

  const pidFile = join(nova.workspacePath, 'nova-e2e-pid.txt')
  const pid = await startLongTaskAndWaitForYield(nova, pidFile)
  expect(isPidAlive(pid)).toBe(true)

  // 关闭应用触发 will-quit 清理链，注册表中的持久进程必须被终止
  await nova.app.close()

  await expect
    .poll(() => isPidAlive(pid), { timeout: 20_000 })
    .toBe(false)
})
