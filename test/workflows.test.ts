import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// Tokens never go into a URL (the process list, .git/config, logs): git gets
// them through GIT_CONFIG_* environment variables (an http.extraheader).
describe('workflows', () => {
  const dir = join(__dirname, '../.github/workflows');
  for (const f of readdirSync(dir)) {
    it(`${f}: no credentials in a URL or on a command line`, () => {
      const y = readFileSync(join(dir, f), 'utf8');
      expect(y).not.toMatch(/https:\/\/[^\s"']*:\$\{[A-Z_]+\}@/); // https://user:${TOKEN}@
      expect(y).not.toMatch(/https:\/\/[^\s"']*\$\{?[A-Z_]*TOKEN[A-Z_]*\}?@/);
      expect(y).not.toMatch(/-c\s+http\.extraheader/); // argv is visible in ps
    });
  }
  it('the deploy authenticates git through GIT_CONFIG_* variables', () => {
    const y = readFileSync(join(dir, 'deploy-production.yml'), 'utf8');
    expect(y).toMatch(/GIT_CONFIG_KEY_0[:=]\s*http\.https:\/\/github\.com\/\.extraheader/);
    expect(y).toMatch(/git clone( -q)? https:\/\/github\.com\/klaushofrichter\/kube-setup\.git/);
  });
});
