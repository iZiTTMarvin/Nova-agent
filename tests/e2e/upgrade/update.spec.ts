import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { launchNova, type NovaHarness } from '../fixtures/nova'

const exec = promisify(execFile)
const root = path.resolve(__dirname, '../../..')

test('已发布旧版可以检测、下载、安装新版并保留会话', async ({}, testInfo) => {
  test.setTimeout(300_000)
  if (process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('NSIS 升级验收只允许在一次性 GitHub Windows runner 上执行')
  }
  const version: string = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version
  const previousVersion = process.env.UPGRADE_FROM_VERSION
  if (!previousVersion || !process.env.RUNNER_TEMP) throw new Error('缺少升级验收参数')
  const installDir = path.join(process.env.RUNNER_TEMP, 'nova-upgrade-install')
  const executablePath = path.join(installDir, 'Nova Agent.exe')
  const publicFeed = process.env.UPGRADE_PUBLIC_FEED === 'true'
  const requests: string[] = []
  const server = createServer(async (request, response) => {
    const name = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname).slice(1)
    if (!['latest.yml', `NovaAgent-Setup-${version}.exe`, `NovaAgent-Setup-${version}.exe.blockmap`].includes(name)) {
      response.writeHead(404).end()
      return
    }
    requests.push(name)
    const file = path.join(root, 'release', name)
    try {
      const info = await stat(file)
      response.writeHead(200, { 'Content-Length': info.size })
      createReadStream(file).pipe(response)
    } catch {
      response.writeHead(404).end()
    }
  })
  let nova: NovaHarness | undefined
  let resumed: NovaHarness | undefined
  const processCommand = "$items = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:NOVA_UPGRADE_EXE }); $items | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction Stop }"
  const stopInstalledApp = () => exec('powershell.exe', ['-NoProfile', '-Command', processCommand], {
    env: { ...process.env, NOVA_UPGRADE_EXE: executablePath }
  })
  try {
    await mkdir(installDir, { recursive: true })
    await exec(path.join(process.env.RUNNER_TEMP, `NovaAgent-Setup-${previousVersion}.exe`), ['/S', `/D=${installDir}`])
    if (!publicFeed) {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('更新服务未监听')
      await writeFile(path.join(installDir, 'resources', 'app-update.yml'),
        `provider: generic\nurl: http://127.0.0.1:${address.port}\nupdaterCacheDirName: nova-upgrade-preflight\n`)
    }
    nova = await launchNova(testInfo, { executablePath })
    expect(await nova.app.evaluate(({ app }) => app.getVersion())).toBe(previousVersion)
    await nova.runTurnToCompletion({ prompt: '保留升级前的会话', text: 'NOVA_BEFORE_UPGRADE' })
    const sessionId = (await nova.getWorkspace()).currentSessionId
    await nova.invoke('app:update:check')
    await expect.poll(async () => (await nova!.invoke('app:update:get-state')).status).toBe('available')
    const available = await nova.invoke('app:update:get-state')
    expect(available).toMatchObject({ status: 'available', currentVersion: previousVersion, update: { version } })
    const downloaded = await nova.invoke('app:update:download')
    expect(downloaded).toMatchObject({ status: 'ready', update: { version } })
    if (!publicFeed) {
      expect(requests).toContain('latest.yml')
      expect(requests).toContain(`NovaAgent-Setup-${version}.exe`)
    }
    await testInfo.attach('update-snapshots', { body: JSON.stringify({ publicFeed, available, downloaded, requests }, null, 2), contentType: 'application/json' })
    const closed = nova.app.waitForEvent('close')
    await nova.invoke('app:update:install')
    await closed
    await expect.poll(async () => {
      const result = await exec('powershell.exe', ['-NoProfile', '-Command',
        "$p = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:NOVA_UPGRADE_EXE }; if ($p) { (Get-Item -LiteralPath $env:NOVA_UPGRADE_EXE).VersionInfo.FileVersion }"],
      { env: { ...process.env, NOVA_UPGRADE_EXE: executablePath } })
      return result.stdout.trim()
    }, { timeout: 90_000 }).toBe(version)
    await stopInstalledApp()
    resumed = await launchNova(testInfo, { executablePath, skipWorkspaceSetup: true }, nova)
    expect(await resumed.app.evaluate(({ app }) => app.getVersion())).toBe(version)
    expect((await resumed.getWorkspace()).currentSessionId).toBe(sessionId)
    await expect(resumed.page.getByText('NOVA_BEFORE_UPGRADE', { exact: false })).toBeVisible()
    await resumed.runTurnToCompletion({ prompt: '升级后继续会话', text: 'NOVA_AFTER_UPGRADE' })
    expect(resumed.pageErrors).toEqual([])
  } finally {
    await stopInstalledApp()
    if (resumed) await resumed.cleanup()
    else if (nova) await nova.cleanup()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => {
      if (error && server.listening) reject(error)
      else resolve()
    }))
  }
})
