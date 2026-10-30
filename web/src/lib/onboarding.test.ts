import { describe, expect, it } from 'vitest';
import { missingText, STEP_LABEL, stepLabel, viewerLine } from './onboarding';

const viewer = (o: Record<string, unknown> = {}) => ({
  instanceId: 'cms_1', name: 'home', state: 'enrolled', lastSeenAt: null, reportAt: 1, hidden: false, applied: true, held: [], heldProxy: [], keptOld: [], problems: [], ...o,
}) as Parameters<typeof viewerLine>[0];

describe('onboarding texts', () => {
  it('missingText for proxy steps, viewers and not-registered', () => {
    expect(missingText('proxy:login')).toBe('Proxy: Camera login missing');
    expect(missingText('proxy:ftp')).toBe('Proxy: Clip upload (FTP) missing');
    expect(missingText('proxy-offline')).toBe('The proxy is offline');
    expect(missingText('proxy:onboarding-unreported')).toBe('The proxy reports no onboarding status for this camera (older cam-proxy?)');
    expect(missingText('proxy:not-ready')).toBe('Proxy: not ready yet');
    expect(missingText('not-registered')).toBe('Not in the account yet');
    expect(missingText('viewer:home:held')).toBe('Viewer home: holds a change (confirm it in that viewer)');
    expect(missingText('viewer:home:kept-old')).toBe('Viewer home: kept the old value (confirm it in that viewer)');
    expect(missingText('viewer:home:not-applied')).toBe('Viewer home: has not applied the current configuration yet');
    expect(missingText('viewer:home:no-report')).toBe('Viewer home: no report yet');
    expect(missingText('something-new')).toBe('something-new');
  });
  it('an unknown step reads as its name', () => {
    expect(stepLabel('lens')).toBe('lens');
    expect(missingText('proxy:lens')).toBe('Proxy: lens missing');
    expect(Object.keys(STEP_LABEL)).toEqual(['reachable', 'login', 'trust', 'capabilities', 'stream', 'events', 'ftp', 'time', 'name', 'poe', 'profile']);
    expect(stepLabel('profile')).toBe("Within the proxy's profile");
  });
  it('viewerLine for each state', () => {
    expect(viewerLine(viewer())).toBe('applied');
    expect(viewerLine(viewer({ applied: false }))).toBe('not applied yet');
    expect(viewerLine(viewer({ applied: null }))).toBe('no report yet');
    expect(viewerLine(viewer({ held: ['host'] }))).toBe('holds: host');
    expect(viewerLine(viewer({ heldProxy: ['url', 'caFingerprints'] }))).toBe('holds: url, caFingerprints');
    expect(viewerLine(viewer({ keptOld: ['host'] }))).toBe('kept old: host');
    expect(viewerLine(viewer({ hidden: true, applied: null }))).toBe('hidden here');
  });
});
