import { defineConfig } from '@playwright/test'
import path from 'node:path'

export default defineConfig({
  testDir: __dirname,
  outputDir: path.resolve(__dirname, '../../test-results/e2e'),
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI
    ? [
        ['line'],
        ['html', { outputFolder: path.resolve(__dirname, '../../playwright-report/e2e'), open: 'never' }]
      ]
    : 'line',
  use: { trace: 'off' }
})
