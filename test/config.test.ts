import { describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config';

describe('config', () => {
  it('has the spec defaults', () => {
    const c = loadConfig({ PUBLIC_URL: 'https://cams-admin.example.net' });
    expect(c).toMatchObject({ port: 8080, heartbeatS: 30, offlineAfterS: 90, pingS: 25, enrollCodeDefaultH: 24, snapshotAt: '03:15', snapshotRetentionDays: 30 });
    expect(c.connectUrl).toBe('wss://cams-admin.example.net/proxy/v1/connect');
    expect(c.dbFile).toBe('/var/lib/cams-admin/cams-admin.db');
  });
  it('derives a ws URL for loopback http and takes PROXY_CONNECT_URL', () => {
    expect(loadConfig({ PUBLIC_URL: 'http://127.0.0.1:29000' }).connectUrl).toBe('ws://127.0.0.1:29000/proxy/v1/connect');
    expect(loadConfig({ PUBLIC_URL: 'https://a.example.net', PROXY_CONNECT_URL: 'http://cams-admin.cams-admin.svc.cluster.local:8080' }).connectUrl)
      .toBe('ws://cams-admin.cams-admin.svc.cluster.local:8080/proxy/v1/connect');
  });
  it('GOOGLE_REDIRECT_URI must be this app\'s callback: path and origin', () => {
    expect(loadConfig({ PUBLIC_URL: 'https://a.example.net', GOOGLE_REDIRECT_URI: 'https://a.example.net/auth/google/callback' }).google.redirectUri).toBe('https://a.example.net/auth/google/callback');
    expect(() => loadConfig({ PUBLIC_URL: 'https://a.example.net', GOOGLE_REDIRECT_URI: 'https://a.example.net/oauth2/callback' })).toThrow(/GOOGLE_REDIRECT_URI.*\/auth\/google\/callback/);
    expect(() => loadConfig({ PUBLIC_URL: 'https://a.example.net', GOOGLE_REDIRECT_URI: 'https://b.example.net/auth/google/callback' })).toThrow(/GOOGLE_REDIRECT_URI.*PUBLIC_URL/);
    expect(loadConfig({ PUBLIC_URL: 'https://a.example.net' }).google.redirectUri).toBe('https://a.example.net/auth/google/callback');
  });

  it('requires PUBLIC_URL and refuses nonsense numbers', () => {
    expect(() => loadConfig({})).toThrow(/PUBLIC_URL/);
    expect(() => loadConfig({ PUBLIC_URL: 'https://a.example.net', HEARTBEAT_S: 'x' })).toThrow(/HEARTBEAT_S/);
    expect(() => loadConfig({ PUBLIC_URL: 'https://a.example.net', BACKUP_SNAPSHOT_RETENTION_DAYS: '0' })).toThrow(/RETENTION/);
  });
});
