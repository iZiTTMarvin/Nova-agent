import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Page,
  type TestInfo
} from '@playwright/test'
import {
  RUN_GET_SNAPSHOT,
  RUN_SNAPSHOT,
  SAVE_MODEL_CONFIG,
  WORKSPACE_CREATE_SESSION,
  WORKSPACE_GET,
  WORKSPACE_SELECT_PROJECT,
  WORKSPACE_SELECT_SESSION
} from '../../../src/shared/ipc/channels'
import type { IpcCommandChannel, IpcCommands, IpcEvents } from '../../../src/shared/ipc/types'
import { isTerminalRunStatus, type RunSnapshot } from '../../../src/shared/run/types'
import type { Mode } from '../../../src/shared/session/types'
import { startFakeRuntime, type FakeRuntime } from './fake-runtime'

const repoRoot = path.resolve(__dirname, '../../..')

type IpcInvokeArgs<C extends IpcCommandChannel> = IpcCommands[C]['params'] extends void
  ? []
  : [IpcCommands[C]['params']]

interface LaunchOptions {
  executablePath?: string
  skipWorkspaceSetup?: boolean
}

export interface NovaHarness {
  app: ElectronApplication
  page: Page
  provider: FakeRuntime
  workspacePath: string
  pageErrors: string[]
  rendererConsole: string[]
  mainConsole: string[]
  invoke: <C extends IpcCommandChannel>(
    channel: C,
    ...args: IpcInvokeArgs<C>
  ) => Promise<IpcCommands[C]['result']>
  getWorkspace: () => Promise<IpcCommands['workspace:get']['result']>
  getRunSnapshot: (sessionId?: string) => Promise<RunSnapshot | null>
  createSession: (mode?: Mode) => Promise<IpcCommands['workspace:create-session']['result']>
  selectSession: (sessionId: string) => Promise<IpcCommands['workspace:select-session']['result']>
  sendPrompt: (text: string) => Promise<void>
  waitUntilIdle: () => Promise<void>
  runTurnToCompletion: (opts: { text: string; prompt: string }) => Promise<RunSnapshot>
  emitRunSnapshot: (payload: IpcEvents['run:snapshot']) => Promise<void>
  cleanup: () => Promise<void>
}

async function rendererInvoke<C extends IpcCommandChannel>(
  page: Page,
  channel: C,
  ...args: IpcInvokeArgs<C>
): Promise<IpcCommands[C]['result']> {
  const result: unknown = await page.evaluate(
    async ({ ipcChannel, ipcArgs }) => {
      const api = (window as typeof window & {
        api?: {
          invoke: (channel: string, ...invokeArgs: unknown[]) => Promise<unknown>
        }
      }).api
      if (!api) {
        throw new Error('window.api is not available')
      }
      return api.invoke(ipcChannel, ...ipcArgs)
    },
    { ipcChannel: channel, ipcArgs: args }
  )
  return result as IpcCommands[C]['result']
}

async function prepareWorkspace(): Promise<string> {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'nova-e2e-workspace-'))
  await writeFile(
    path.join(workspacePath, 'e2e-marker.txt'),
    'Nova Electron E2E marker\n',
    'utf8'
  )
  return workspacePath
}

function isolatedElectronEnv(profileRoot: string): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
  return {
    ...inherited,
    NODE_ENV: 'production',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    APPDATA: path.join(profileRoot, 'appdata'),
    XDG_CONFIG_HOME: path.join(profileRoot, 'xdg'),
    HOME: path.join(profileRoot, 'home')
  }
}

export function packagedExecutablePath(): string {
  if (process.platform === 'win32') {
    return path.join(repoRoot, 'release', 'win-unpacked', 'Nova Agent.exe')
  }
  if (process.platform === 'darwin') {
    return path.join(repoRoot, 'release', 'mac', 'Nova Agent.app', 'Contents', 'MacOS', 'Nova Agent')
  }
  return path.join(repoRoot, 'release', 'linux-unpacked', 'nova-agent')
}

export async function launchNova(
  testInfo: TestInfo,
  options: LaunchOptions = {}
): Promise<NovaHarness> {
  const provider = await startFakeRuntime()
  const workspacePath = await prepareWorkspace()
  const profileRoot = await mkdtemp(path.join(os.tmpdir(), 'nova-e2e-profile-'))
  const userDataDir = path.join(profileRoot, 'userData')
  await Promise.all([
    mkdir(path.join(profileRoot, 'appdata'), { recursive: true }),
    mkdir(path.join(profileRoot, 'xdg'), { recursive: true }),
    mkdir(path.join(profileRoot, 'home'), { recursive: true }),
    mkdir(userDataDir, { recursive: true })
  ])

  const pageErrors: string[] = []
  const rendererConsole: string[] = []
  const mainConsole: string[] = []

  const launchEnv = isolatedElectronEnv(profileRoot)
  // Windows 上 APPDATA 不会改 Electron userData，必须传 Chromium 开关才能隔离 profile 与单实例锁。
  const userDataArg = `--user-data-dir=${userDataDir}`
  const app = options.executablePath
    ? await electron.launch({
        executablePath: options.executablePath,
        args: [userDataArg],
        env: launchEnv
      })
    : await electron.launch({
        args: [userDataArg, repoRoot],
        cwd: repoRoot,
        env: launchEnv
      })
  app.on('console', message => {
    mainConsole.push(`[${message.type()}] ${message.text()}`)
  })

  const page = await app.firstWindow()
  page.on('pageerror', error => {
    pageErrors.push(error.stack ?? error.message)
  })
  page.on('console', message => {
    rendererConsole.push(`[${message.type()}] ${message.text()}`)
  })

  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean((window as typeof window & { api?: unknown }).api))

  const context = app.context()
  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true
  })

  let cleaned = false

  const invoke = <C extends IpcCommandChannel>(channel: C, ...args: IpcInvokeArgs<C>) =>
    rendererInvoke(page, channel, ...args)

  if (!options.skipWorkspaceSetup) {
    await invoke(SAVE_MODEL_CONFIG, {
      baseUrl: provider.baseUrl,
      apiKey: 'nova-e2e-key',
      modelId: 'nova-e2e-model',
      cacheProfile: 'generic',
      toolDialect: 'native'
    })
    await invoke(WORKSPACE_SELECT_PROJECT, { path: workspacePath })

    // Renderer 启动时会读取模型与 workspace；setup 后重载一次，让后续路径等同正常启动。
    await page.reload()
    await page.waitForFunction(() => Boolean((window as typeof window & { api?: unknown }).api))
  }

  await expect(page.getByLabel('消息输入')).toBeVisible()

  const getWorkspace = () => invoke(WORKSPACE_GET)

  const getRunSnapshot = async (sessionId?: string): Promise<RunSnapshot | null> => {
    const workspace = sessionId ? null : await getWorkspace()
    const targetSessionId = sessionId ?? workspace?.currentSessionId
    if (!targetSessionId) return null
    const result = await invoke(RUN_GET_SNAPSHOT, {
      sessionId: targetSessionId
    })
    return result.snapshot
  }

  const sendPrompt = async (text: string): Promise<void> => {
    const input = page.getByLabel('消息输入')
    await expect(input).toBeVisible()
    await input.fill(text)
    await page.getByRole('button', { name: '发送' }).click()
  }

  const waitUntilIdle = async (): Promise<void> => {
    await expect.poll(async () => {
      const snapshot = await getRunSnapshot()
      return snapshot == null || isTerminalRunStatus(snapshot.status)
    }).toBe(true)
    await expect(
      page.getByRole('button', { name: /^(中断生成|正在停止|强制终止)$/ })
    ).toHaveCount(0)
    await expect(page.getByLabel('消息输入')).toBeEditable()
  }

  // 跑一轮对话到权威终态并返回该快照，供异常注入用例作公共前置。
  const runTurnToCompletion = async (opts: {
    text: string
    prompt: string
  }): Promise<RunSnapshot> => {
    provider.enqueue({ kind: 'text', text: opts.text })
    await sendPrompt(opts.prompt)
    await expect(page.getByText(opts.text, { exact: false })).toBeVisible()
    await waitUntilIdle()
    const completed = await getRunSnapshot()
    if (!completed) throw new Error('completed run snapshot missing')
    expect(completed.status).toBe('completed')
    return completed
  }

  const harness: NovaHarness = {
    app,
    page,
    provider,
    workspacePath,
    pageErrors,
    rendererConsole,
    mainConsole,
    invoke,
    getWorkspace,
    getRunSnapshot,
    createSession: (mode?: Mode) =>
      invoke(WORKSPACE_CREATE_SESSION, {
        workspaceRoot: workspacePath,
        ...(mode ? { mode } : {})
      }),
    selectSession: (sessionId: string) =>
      invoke(WORKSPACE_SELECT_SESSION, { sessionId }),
    sendPrompt,
    waitUntilIdle,
    runTurnToCompletion,
    emitRunSnapshot: async payload => {
      await app.evaluate(({ BrowserWindow }, data) => {
        const window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed())
        if (!window) throw new Error('Nova BrowserWindow not found')
        window.webContents.send(data.channel, data.payload)
      }, { channel: RUN_SNAPSHOT, payload })
    },
    cleanup: async () => {
      if (cleaned) return
      cleaned = true

      const failed = testInfo.status !== testInfo.expectedStatus
      try {
        if (failed && !page.isClosed()) {
          const screenshot = testInfo.outputPath('renderer.png')
          await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined)
          await testInfo.attach('renderer-screenshot', {
            path: screenshot,
            contentType: 'image/png'
          }).catch(() => undefined)
        }

        const tracePath = failed ? testInfo.outputPath('trace.zip') : undefined
        await context.tracing.stop(tracePath ? { path: tracePath } : undefined).catch(() => undefined)
        if (tracePath) {
          await testInfo.attach('playwright-trace', {
            path: tracePath,
            contentType: 'application/zip'
          }).catch(() => undefined)
        }

        const diagnostics = [
          '=== page errors ===',
          ...pageErrors,
          '',
          '=== renderer console ===',
          ...rendererConsole,
          '',
          '=== main console ===',
          ...mainConsole
        ].join('\n')
        const diagnosticsPath = testInfo.outputPath('diagnostics.log')
        await writeFile(diagnosticsPath, diagnostics, 'utf8')
        if (failed) {
          await testInfo.attach('electron-diagnostics', {
            path: diagnosticsPath,
            contentType: 'text/plain'
          }).catch(() => undefined)
        }
      } finally {
        await app.close().catch(() => undefined)
        await provider.close().catch(() => undefined)
        await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined)
        await rm(profileRoot, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  return harness
}

export const test = base.extend<{ nova: NovaHarness }>({
  nova: async ({}, use, testInfo) => {
    const nova = await launchNova(testInfo)
    try {
      await use(nova)
    } finally {
      await nova.cleanup()
    }
  }
})

export { expect }
