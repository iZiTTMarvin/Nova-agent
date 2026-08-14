import { expect, test } from '@playwright/test'
import { launchNova, packagedExecutablePath } from '../fixtures/nova'

test('Windows unpacked release 启动后可完成一条真实聊天链路', async ({}, testInfo) => {
  test.skip(process.platform !== 'win32', 'packaged release gate runs on Windows')

  const nova = await launchNova(testInfo, { executablePath: packagedExecutablePath() })

  try {
    nova.provider.enqueue({ kind: 'text', text: 'NOVA_E2E_PACKAGED_OK' })
    await nova.sendPrompt('验证打包后的 Nova')
    await expect(nova.page.getByText('NOVA_E2E_PACKAGED_OK', { exact: false })).toBeVisible()
    await nova.waitUntilIdle()
    expect((await nova.getRunSnapshot())?.status).toBe('completed')
    expect(nova.pageErrors).toEqual([])
  } finally {
    await nova.cleanup()
  }
})
