import { defineConfig, devices } from '@playwright/test';
import { BASE, GOOGLE_PORT, PORT } from './e2e/env';

// Requires `npm run build` first. Desktop 1440×900 and phone 390×844 (spec
// §15.1). A fake Google answers the OAuth redirects; real Google is never used.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  timeout: 45_000,
  use: { baseURL: BASE, trace: 'retain-on-failure', colorScheme: 'dark' },
  projects: [
    { name: 'desktop', testIgnore: /restart\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'phone', testIgnore: /restart\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, hasTouch: true } },
    // Starts and restarts its own server: once, after the others.
    { name: 'restart', testMatch: /restart\.spec\.ts/, dependencies: ['desktop', 'phone'], use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: [
    { command: `npx tsx test/fakeGoogle.ts ${GOOGLE_PORT}`, port: GOOGLE_PORT, reuseExistingServer: false },
    { command: 'npx tsx e2e/server.ts --fresh', url: `${BASE}/health`, reuseExistingServer: false, timeout: 60_000 },
  ],
});
void PORT;
