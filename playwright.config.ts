import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.PGLENS_E2E_PORT ?? 54321)
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    // The CLI start command would fork a detached child; for the test we
    // run `pglens serve` directly so Playwright owns the lifecycle.
    command: 'node bin/pglens serve',
    url: `${BASE_URL}/api/v3/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      PGLENS_LOG_LEVEL: 'warn',
      PGLENS_V3: '1',
    },
  },
})
