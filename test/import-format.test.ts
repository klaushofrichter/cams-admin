import { describe, expect, it } from 'vitest';
import { formatImport } from '../scripts/import-format';

describe('npm run import output', () => {
  it('lists changes, mismatch ids and the outcome; only hash prefixes', () => {
    const lines = formatImport({
      dryRun: true, account: 'home', instance: 'cluster', blocked: true, applied: false, noChanges: false, blockers: ['unknown_proxy'],
      changes: [
        { kind: 'proxy-matched', proxyId: 'prx_1', name: 'pi', by: 'token', fileUrl: 'https://proxy.example.net' },
        { kind: 'token-external', proxyId: 'prx_1', name: 'pi', tokenKind: 'client', hashPrefix: 'sha256:1a2b3c4d' },
        { kind: 'camera-change', cameraId: 'cam_1', camsId: 'cam1', fields: { name: { from: 'A', to: 'B' } } },
      ],
      mismatches: [{ id: 'abcdef012345', what: 'pin-differs', proxyId: 'prx_1', detail: 'pi reports …' }],
    });
    expect(lines).toEqual([
      'dry run: account home, instance cluster',
      '  proxy pi: matched by token (https://proxy.example.net)',
      '  external client token on pi: sha256:1a2b3c4d',
      '  camera cam1: name "A" → "B"',
      '  MISMATCH abcdef012345 pin-differs: pi reports …',
      '  BLOCKED: unknown_proxy (--create-proxies)',
      'Not applied: accept the mismatches (--accept-mismatch) or fix them.',
    ]);
  });
});
