// Realistic cam-proxy health summaries (schema 1, cam-proxy
// src/health/summary.ts) for the contract fixtures, the tests, the load test
// and the local stack. Addresses are RFC 5737; nothing here is a real host.

export interface SummaryOptions {
  cameras: number;
  now: number;
  version?: string;
  startedAt?: number;
  offline?: string[]; // camera ids shown offline
  pi?: boolean; // the Pi: platform.pi, host stats, cpuTemp/underVoltage items
  site?: boolean; // a site CA: the certificates item and per-camera cert
}

type Item = { id: string; label: string; value: boolean | number | string | null; text: string; problem: boolean };

function cameraBlock(i: number, o: SummaryOptions) {
  const id = `cam${i + 1}`;
  const online = !(o.offline ?? []).includes(id);
  const items: Item[] = [
    { id: 'camera', label: 'Camera', value: online, text: online ? 'online' : 'offline', problem: !online },
    { id: 'stream', label: 'Live stream', value: online ? 'up' : 'down', text: online ? 'up' : 'down', problem: !online },
    { id: 'events', label: 'Events intake', value: online ? 'subscribed' : 'down', text: online ? 'subscribed' : 'down, polling', problem: !online },
    { id: 'ftp', label: 'Camera FTP upload', value: 'on', text: 'on', problem: false },
  ];
  return {
    camera: {
      id, name: `Camera ${i + 1}`, address: `192.0.2.${10 + i}`, online, since: o.now - 3600_000 * (i + 1), model: 'RLC-1224A', firmware: 'v3.1.0.4054_2408211442',
      clockOffsetMs: 120 + i, error: online ? null : 'connect ETIMEDOUT', reboot: null, poeSwitch: i === 0 ? { model: 'sscpoe-web', port: 8 } : null,
    },
    stream: { enabled: true, up: online, lastFrameAt: online ? o.now - 1000 : o.now - 600_000 },
    events: { onvif: online ? 'subscribed' : 'down', source: online ? 'onvif' : 'poll', since: o.now - 7200_000, resubscribes: 3 + i },
    ftp: { enabled: true, listening: true, cameraUpload: 'on', checkedAt: o.now - 60_000, lastClipAt: o.now - 900_000, clipsStored: 120 + i, failures: 0, stalled: false, eventsWithoutClip: 0 },
    cert: o.site ? { mode: 'site-ca', servername: `${id}.garage.internal`, fingerprint: 'SHA256:' + 'AB'.repeat(32), notAfter: o.now + 300 * 86400_000, lastPush: { at: o.now - 86400_000, outcome: 'current' }, problem: null } : null,
    items,
  };
}

function aggregate(id: string, label: string, word: string, per: Item[]): Item {
  if (per.length === 1) return per[0];
  const bad = per.filter((p) => p.problem).length;
  const value = per.length - bad;
  return { id, label, value, text: bad ? `${value} of ${per.length} ${word}` : `all ${per.length} ${per[0].text}`, problem: bad > 0 };
}

export function makeSummary(o: SummaryOptions) {
  const n = Math.max(1, o.cameras);
  const version = o.version ?? 'v2026.10.06.1';
  const cams = Array.from({ length: n }, (_, i) => cameraBlock(i, o));
  const items: Item[] = [
    aggregate('camera', 'Camera', 'online', cams.map((c) => c.items[0])),
    aggregate('stream', 'Live stream', 'up', cams.map((c) => c.items[1])),
    aggregate('events', 'Events intake', 'subscribed', cams.map((c) => c.items[2])),
    aggregate('ftp', 'Camera FTP upload', 'on', cams.map((c) => c.items[3])),
    { id: 'storage', label: 'Storage', value: 'writing', text: 'writing', problem: false },
    { id: 'disk', label: 'Disk', value: 41.5, text: '41.5 % of 234.0 GB', problem: false },
  ];
  if (o.site) items.push({ id: 'certificates', label: 'Certificates', value: 300, text: 'valid 300 more days', problem: false });
  if (o.pi) {
    items.push({ id: 'cpuTemp', label: 'CPU temperature', value: 52.1, text: '52.1 °C', problem: false });
    items.push({ id: 'underVoltage', label: 'Under-voltage', value: false, text: 'no', problem: false });
  }
  items.push({ id: 'inventory', label: 'Last inventory', value: 'ok', text: 'clips: ok', problem: false });
  items.push({ id: 'version', label: 'Version', value: version, text: version, problem: false });
  const problemCount = items.filter((x) => x.problem).length;
  return {
    schema: 1 as const,
    generatedAt: o.now,
    version,
    startedAt: o.startedAt ?? o.now - 86400_000,
    ok: problemCount === 0,
    problemCount,
    thresholds: { diskPercent: 90, tempC: 75, ftpStalledHours: 6 },
    platform: { pi: !!o.pi, model: o.pi ? 'Raspberry Pi 4 Model B Rev 1.5' : null, hostStats: !!o.pi },
    items,
    camera: cams[0].camera,
    stream: cams[0].stream,
    events: cams[0].events,
    ftp: cams[0].ftp,
    proxy: {
      sseClients: 2,
      storagePaused: false,
      lastRetentionRun: o.now - 1800_000,
      recordingsCache: { bytes: 1_234_567_890, files: 42, capBytes: 10_737_418_240 },
      lastInventory: { kind: 'clips', op: 'check', outcome: 'ok', startedAt: o.now - 86400_000, message: 'clips: 120 checked, 0 missing' },
    },
    disk: { sizeBytes: 251_000_000_000, freeBytes: 146_800_000_000, usedBytes: 104_200_000_000, usedPercent: 41.5 },
    host: o.pi ? { cpuTempC: 52.1, underVoltage: false, memory: { totalBytes: 8_000_000_000, availableBytes: 5_500_000_000, usedPercent: 31.3 }, uptimeS: 864000, load: { m1: 0.42, m5: 0.38, m15: 0.35 } } : null,
    cameras: cams,
  };
}

export type Summary = ReturnType<typeof makeSummary>;

// The heartbeat body's `proxy` part (spec §8.5).
export function makeProxyInfo(o: { now: number; startedAt?: number; site?: string | null; caFingerprint?: string[]; publicUrl?: string | null }) {
  const startedAt = o.startedAt ?? o.now - 86400_000;
  return {
    startedAt,
    uptimeS: Math.round((o.now - startedAt) / 1000),
    configSchema: 7,
    tls: o.site ? { site: o.site, caFingerprint: o.caFingerprint ?? ['SHA256:' + 'CD'.repeat(32)] } : null,
    publicUrl: o.publicUrl ?? null,
  };
}

// Spec §8.5: over 192 KiB, keep items, cameras[].camera and cameras[].items.
export function truncateSummary(s: Summary) {
  return { schema: s.schema, generatedAt: s.generatedAt, version: s.version, ok: s.ok, problemCount: s.problemCount, items: s.items, cameras: s.cameras.map((c) => ({ camera: c.camera, items: c.items })) };
}
