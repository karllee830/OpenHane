import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'apps',
  testMatch: '*/e2e/*.spec.ts',
  globalSetup: './apps/web/e2e/global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: { viewport: { width: 1280, height: 800 }, trace: 'retain-on-failure' },
});
