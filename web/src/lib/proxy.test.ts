import { describe, expect, it } from 'vitest';
import { hostLabel, proxyForm, proxyPatch, validProxyName } from './proxy';

const row = {
  displayName: 'Pi', name: 'pi', runsOn: 'local-host', hostKind: null, url: 'https://proxy.example.net:8480', adminUiUrl: null,
  dnsName: null, tlsSite: null, tlsServername: null, caFingerprints: ['SHA256:AA', 'SHA256:BB'], notes: null,
};
const saved = proxyForm(row);

describe('the proxy registry form', () => {
  it('fills empty values as empty strings, fingerprints one per line', () => {
    expect(saved).toEqual({ displayName: 'Pi', name: 'pi', runsOn: 'local-host', hostKind: '', url: 'https://proxy.example.net:8480', adminUiUrl: '', dnsName: '', tlsSite: '', tlsServername: '', fps: 'SHA256:AA\nSHA256:BB', notes: '' });
  });

  it('nothing changed: an empty patch, also for spacing alone', () => {
    expect(proxyPatch(saved, saved)).toEqual({});
    expect(proxyPatch({ ...saved, name: ' pi ', fps: 'SHA256:AA, SHA256:BB\n' }, saved)).toEqual({});
  });

  it('sends only the changed fields, trimmed', () => {
    expect(proxyPatch({ ...saved, name: ' garage ', adminUiUrl: ' https://proxy.example.net ' }, saved)).toEqual({ name: 'garage', adminUiUrl: 'https://proxy.example.net' });
    expect(proxyPatch({ ...saved, fps: 'SHA256:CC' }, saved)).toEqual({ caFingerprints: ['SHA256:CC'] });
    expect(proxyPatch({ ...saved, fps: '' }, saved)).toEqual({ caFingerprints: [] });
  });

  it('an emptied optional field is null; an emptied name stays empty so the server refuses it', () => {
    expect(proxyPatch({ ...saved, url: '' }, saved)).toEqual({ url: null });
    expect(proxyPatch({ ...saved, displayName: '' }, saved)).toEqual({ displayName: '' });
    expect(validProxyName('')).toBe(false);
  });
});

describe('hostLabel: where a proxy runs, in words', () => {
  it.each([
    ['local-host', null, 'This network'],
    ['cluster', null, 'Cluster'],
    ['cloud', undefined, 'Cloud'],
    ['cluster', '', 'Cluster'],
    ['local-host', 'pi', 'This network · Pi'],
    ['local-host', 'mini-pc', 'This network · Mini PC'],
    ['local-host', 'pc', 'This network · PC'],
    ['local-host', 'mac', 'This network · Mac'],
    ['cloud', 'vm', 'Cloud · VM'],
    ['cluster', 'container', 'Cluster · Container'],
    ['local-host', 'other', 'This network · Other'],
  ])('%s, %s: %s', (runsOn, kind, text) => {
    expect(hostLabel(runsOn, kind)).toBe(text);
  });

  it('a value it does not know is shown as stored', () => {
    expect(hostLabel('moon-base', 'rover')).toBe('moon-base · rover');
  });
});
