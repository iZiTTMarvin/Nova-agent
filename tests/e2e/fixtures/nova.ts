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
import type { RunSnapshot } from '../../../src/shared/run/types'
import type { WorkspaceState } from '../../../src/shared/workspace/types'
import { startFakeRuntime, type FakeRuntime } from './fake-runtime'

const repoRoot = path.resolve(__dirname, '../../..')

interface SnapshotResponse {
  snapshot: RunSnapshot | null
  waitingSessions: Array<{
    sessionId: string
    runId: string
    pendingCount: number
  }>
}

interface LaunchOptions {
  executablePath?: string
}

export interface NovaHarness {
  app: ElectronApplication
  page: Page
  provider: FakeRuntime
  workspacePath: string
  pageErrors: string[]
  rendererConsole: string[]
  mainConsole: string[]
  invoke: <T>(channel: string, ...args: unknown[]) => Promise<T>
  getWorkspace: () => Promise<WorkspaceState>
  getRunSnapshot: (sessionId?: string) => Promise<RunSnapshot | null>
  createSession: () => Promise<WorkspaceState>
  selectSession: (sessionId: string) => Promise<WorkspaceState>
  sendPrompt: (text: string) => Promise<void>
  waitUntilIdle: () => Promise<void>
  emitRunSnapshot: (
    snapshot: RunSnapshot,
    event?: { sequence: number; type: string; at: number }
  ) => Promise<void>
  cleanup: () => Promise<void>
}

async function rendererInvoke<T>(
  page: Page,
  channel: string,
  ...args: unknown[]
): Promise<T> {
  return page.evaluate(
    async ({ ipcChannel, ipcArgs }) => {
      const api = (window as typeof window & {
        api: {
          invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
        }
      }).api
      return (await api.invoke(ipcChannel, ...ipcArgs)) as T
    },
    { ipcChannel: channel, ipcArgs: args }
  )
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

function isolatedElectronEnv(profileRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
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
  await Promise.all([
    mkdir(path.join(profileRoot, 'appdata'), { recursive: true }),
    mkdir(path.join(profileRoot, 'xdg'), { recursive: true }),
    mkdir(path.join(profileRoot, 'home'), { recursive: true })
  ])

  const pageErrors: string[] = []
  const rendererConsole: string[] = []
  const mainConsole: string[] = []

  const app = options.executablePath
    ? await electron.launch({
        executablePath: options.executablePath,
        env: isolatedElectronEnv(profileRoot)
      })
    : await electron.launch({
        args: [repoRoot],
        cwd: repoRoot,
        env: isolatedElectronEnv(profileRoot)
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

  const invoke = <T>(channel: string, ...args: unknown[]) =>
    rendererInvoke<T>(page, channel, ...args)

  await invoke<void>(SAVE_MODEL_CONFIG, {
    baseUrl: provider.baseUrl,
    apiKey: 'nova-e2e-key',
    modelId: 'nova-e2e-model',
    cacheProfile: 'generic',
    toolDialect: 'native'
  })
  await invoke<WorkspaceState>(WORKSPACE_SELECT_PROJECT, { path: workspacePath })

  // Renderer 启动时会读取模型与 workspace；setup 后重载一次，让后续路径等同正常启动。
  await page.reload()
  await page.waitForFunction(() => Boolean((window as typeof window & { api?: unknown }).api))
  await expect(page.getByLabel('消息输入')).toBeVisible()

  const getWorkspace = () => invoke<WorkspaceState>(WORKSPACE_GET)

  const getRunSnapshot = async (sessionId?: string): Promise<RunSnapshot | null> => {
    const workspace = sessionId ? null : await getWorkspace()
    const targetSessionId = sessionId ?? workspace?.currentSessionId
    if (!targetSessionId) return null
    const result = await invoke<SnapshotResponse>(RUN_GET_SNAPSHOT, {
      sessionId: targetSessionId
    })
    return result.snapshot
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
    createSession: () =>
      invoke<WorkspaceState>(WORKSPACE_CREATE_SESSION, {
        workspaceRoot: workspacePath
      }),
    selectSession: (sessionId: string) =>
      invoke<WorkspaceState>(WORKSPACE_SELECT_SESSION, { sessionId }),
    sendPrompt: async (text: string) => {
      const input = page.getByLabel('消息输入')
      await expect(input).toBeVisible()
      await input.fill(text)
      await page.getByRole('button', { name: '发送' }).click()
    },
    waitUntilIdle: async () => {
      await expect(page.getByRole('button', { name: '中断生成' })).toHaveCount(0)
      await expect(page.getByLabel('消息输入')).toBeEditable()
    },
    emitRunSnapshot: async (snapshot, event) => {
      const payload = {
        snapshot,
        event: event ?? {
          sequence: snapshot.sequence,
          type: 'e2e_injected_snapshot',
          at: Date.now()
        },
        channel: RUN_SNAPSHOT
      }
      await app.evaluate(({ BrowserWindow }, data) => {
        const window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed())
        if (!window) throw new Error('Nova BrowserWindow not found')
        window.webContents.send(data.channel, {
          snapshot: data.snapshot,
          event: data.event
        })
      }, payload)
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
