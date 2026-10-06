import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'web/src/**/*.test.ts'],
    env: { LOG_LEVEL: 'silent', TZ: 'America/Chicago' },
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
