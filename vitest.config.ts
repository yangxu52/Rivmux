import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

import { createBrowserTestServer } from './tests/browser/support/test-server'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/{fixtures,integration}/**/*.test.ts'],
        },
      },
      {
        plugins: [createBrowserTestServer()],
        test: {
          name: 'browser',
          include: ['tests/browser/**/*.test.ts'],
          browser: {
            provider: playwright(),
            enabled: true,
            headless: true,
            screenshotFailures: false,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})
