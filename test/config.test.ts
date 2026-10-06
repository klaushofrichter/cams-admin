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
  it('the callback is served on GOOGLE_REDIRECT_URI\'s path (default /auth/callback), on the PUBLIC_URL origin', () => {
    expect(loadConfig({ PUBLIC_URL: 'https://a.example.net' }).google).toMatchObject({ redirectUri: 'https://a.example.net/auth/callback', callbackPath: '/auth/callback' });
    expect(loadConfig({ PUBLIC_URL: 'https://a.example.net', GOOGLE_REDIRECT_URI: 'https://a.example.net/auth/callback' }).google.callbackPath).toBe('/auth/callback');
    expect(loadConfig({ PUBLIC_URL: 'https://a.example.net', GOOGLE_REDIRECT_URI: 'https://a.example.net/auth/google/callback' }).google.callbackPath).toBe('/auth/google/callback');
    for (const bad of ['https://a.example.net/oauth2/callback', 'https://a.example.net/auth/logout', 'https://a.example.net/auth/google/login', 'https://a.example.net/auth/', 'https://a.example.net/auth/x?y=1', 'https://a.example.net/auth/../api']) {
      expect(() => loadConfig({ PUBLIC_URL: 'https://a.example.net', GOOGLE_REDIRECT_URI: bad }), bad).toThrow(/GOOGLE_REDIRECT_URI/);
    }
    expect(() => loadConfig({ PUBLIC_URL: 'https://a.example.net', GOOGLE_REDIRECT_URI: 'https://b.example.net/auth/callback' })).toThrow(/GOOGLE_REDIRECT_URI.*PUBLIC_URL/);
  });

  it('INTERNAL_URLS: optional origins (http only in-cluster or loopback), PUBLIC_URL always allowed', () => {
    expect(loadConfig({ PUBLIC_URL: 'https://a.example.net' }).connectOrigins).toEqual(['https://a.example.net']);
    const c = loadConfig({ PUBLIC_URL: 'https://a.example.net/', INTERNAL_URLS: ' http://cams-admin.cams-admin.svc.cluster.local:8080 , http://127.0.0.1:29000/,https://b.example.net' });
    expect(c.connectOrigins).toEqual(['https://a.example.net', 'http://cams-admin.cams-admin.svc.cluster.local:8080', 'http://127.0.0.1:29000', 'https://b.example.net']);
    for (const bad of ['http://b.example.net', 'ftp://x.svc.cluster.local', 'http://x.svc.cluster.local:8080/api', 'http://x.svc.cluster.local?a=1', 'http://u:p@x.svc.cluster.local', 'not a url', 'http://svc.cluster.local.example.net']) {
      expect(() => loadConfig({ PUBLIC_URL: 'https://a.example.net', INTERNAL_URLS: bad }), bad).toThrow(/INTERNAL_URLS/);
    }
  });

  it('requires PUBLIC_URL and refuses nonsense numbers', () => {
    expect(() => loadConfig({})).toThrow(/PUBLIC_URL/);
    expect(() => loadConfig({ PUBLIC_URL: 'https://a.example.net', HEARTBEAT_S: 'x' })).toThrow(/HEARTBEAT_S/);
    expect(() => loadConfig({ PUBLIC_URL: 'https://a.example.net', BACKUP_SNAPSHOT_RETENTION_DAYS: '0' })).toThrow(/RETENTION/);
  });
});
