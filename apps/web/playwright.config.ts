import { defineConfig, devices } from '@playwright/test';

/**
 * UI checks. By default they run against the local production build (vite preview).
 * Set BASE_URL to run the same suite against a deployed URL.
 */
// Typed without @types/node (not an approved dependency); Playwright runs this file in Node.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const baseURL = env.BASE_URL ?? 'http://localhost:4173';
const local = !env.BASE_URL;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: local
    ? { command: 'pnpm build && pnpm preview', url: baseURL, reuseExistingServer: false, timeout: 120_000 }
    : undefined,
});
