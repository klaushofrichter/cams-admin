import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// deploy/litestream.yml is copied into kube-setup's cams-admin-litestream ConfigMap; a copy must not undo the cluster's settings.
const yml = readFileSync(join(__dirname, '../deploy/litestream.yml'), 'utf8');

describe('deploy/litestream.yml', () => {
  it('checks L0 retention hourly, not every 15 s (each check LISTs the S3 replica)', () => {
    expect(yml).toMatch(/^l0-retention-check-interval: 1h$/m);
  });
});
