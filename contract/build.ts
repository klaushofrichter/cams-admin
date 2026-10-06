// Builds the v1 JSON Schemas (draft 2020-12) of the cams-admin proxy
// protocol, in two modes:
//   lenient: what the server accepts at run time (spec §8.1: unknown fields
//            are ignored; enums of the health summary are plain strings, so a
//            newer cam-proxy never blinds the dashboard);
//   strict:  additionalProperties false everywhere, every listed field
//            required, enums enforced. The tests of both repos use it; it is
//            what catches drift (spec §15.4).
// `npm run contract:make` writes contract/v1/*.schema.json (lenient) and
// contract/v1/strict/*.schema.json from this file; a test checks the
// committed files equal a fresh build.

export type Mode = 'lenient' | 'strict';
type S = Record<string, unknown>;

const BASE = 'https://cams-admin.skylar.technology/contract/v1/';
const TEXT = 200; // spec §8.5: ≤ 200 characters per text field

export function buildSchemas(mode: Mode): Record<string, S> {
  const strict = mode === 'strict';
  const str = (max = TEXT, extra: S = {}): S => ({ type: 'string', maxLength: max, ...extra });
  const int = (min = 0, extra: S = {}): S => ({ type: 'integer', minimum: min, ...extra });
  const num: S = { type: 'number' };
  const bool: S = { type: 'boolean' };
  const nullable = (s: S): S => ({ anyOf: [s, { type: 'null' }] });
  const en = (values: string[]): S => (strict ? { type: 'string', enum: values } : str(64));
  const arr = (items: S, maxItems: number, extra: S = {}): S => ({ type: 'array', items, maxItems, ...extra });
  // An object: strict closes it and requires every property except `optional`.
  const obj = (props: Record<string, S>, required: string[], optional: string[] = []): S => ({
    type: 'object',
    properties: props,
    required: strict ? Object.keys(props).filter((k) => !optional.includes(k)) : required,
    ...(strict ? { additionalProperties: false } : {}),
  });
  const id = (prefix: string): S => ({ type: 'string', pattern: `^${prefix}_[0-9A-HJKMNP-TV-Z]{20}$` });
  const b64 = (len: number): S => ({ type: 'string', maxLength: len, pattern: '^[A-Za-z0-9+/]+={0,2}$' });
  const fp: S = { type: 'string', pattern: '^SHA256:[0-9A-F]{64}$' };

  // --- the health summary (cam-proxy src/health/summary.ts, schema 1) ----------
  const item = obj({
    id: en(['camera', 'stream', 'events', 'ftp', 'storage', 'disk', 'archive', 'certificates', 'cpuTemp', 'underVoltage', 'inventory', 'version']),
    label: str(), value: { anyOf: [bool, num, str(), { type: 'null' }] }, text: str(), problem: bool,
  }, ['id', 'label', 'text', 'problem']);
  const items = arr(item, 64);
  const camera = obj({
    id: str(64), name: str(), address: str(), online: bool, since: int(), model: nullable(str()), firmware: nullable(str()),
    clockOffsetMs: nullable(num), error: nullable(str()), reboot: nullable(en(['power-cycling', 'rebooting', 'back', 'not-back'])),
    poeSwitch: nullable(obj({ model: str(64), port: nullable(int()) }, ['model'])),
  }, ['id', 'online']);
  const stream = obj({ enabled: bool, up: bool, lastFrameAt: nullable(int()) }, []);
  const events = obj({ onvif: en(['subscribed', 'connecting', 'down']), source: en(['onvif', 'poll', 'none']), since: int(), resubscribes: int() }, []);
  const ftp = obj({
    enabled: bool, listening: bool, cameraUpload: nullable(en(['on', 'off', 'elsewhere', 'server_differs', 'not_set_up', 'unknown'])), checkedAt: nullable(int()),
    lastClipAt: nullable(int()), clipsStored: int(), failures: int(), stalled: bool, eventsWithoutClip: int(),
  }, []);
  const cert = obj({
    mode: en(['site-ca', 'pinned', 'public', 'none']), servername: nullable(str()), fingerprint: nullable(str()), notAfter: nullable(int()),
    lastPush: nullable(obj({ at: int(), outcome: en(['current', 'pushed', 'refused', 'failed']) }, [])), problem: nullable(str()),
  }, []);
  const cameraHealth = obj({ camera, stream, events, ftp, cert: nullable(cert), items }, ['camera', 'items']);
  const summaryProps: Record<string, S> = {
    schema: { const: 1 }, generatedAt: int(), version: str(64), startedAt: nullable(int()), ok: bool, problemCount: int(),
    thresholds: obj({ diskPercent: num, tempC: num, ftpStalledHours: num, archiveWarnPercent: num }, [], ['archiveWarnPercent']),
    platform: obj({ pi: bool, model: nullable(str()), hostStats: bool }, []),
    items, camera, stream, events, ftp,
    proxy: obj({
      sseClients: int(), storagePaused: bool, lastRetentionRun: nullable(int()),
      recordingsCache: obj({ bytes: int(), files: int(), capBytes: int() }, []),
      lastInventory: nullable(obj({ kind: str(64), op: en(['check', 'repair']), outcome: en(['ok', 'cancelled', 'failed']), startedAt: int(), message: str() }, [])),
    }, []),
    disk: nullable(obj({ sizeBytes: int(), freeBytes: int(), usedBytes: int(), usedPercent: num }, [])),
    host: nullable(obj({
      cpuTempC: nullable(num), underVoltage: nullable(bool),
      memory: nullable(obj({ totalBytes: int(), availableBytes: int(), usedPercent: num }, [])),
      uptimeS: nullable(num), load: nullable(obj({ m1: num, m5: num, m15: num }, [])),
    }, [])),
    cameras: arr(cameraHealth, 64),
  };
  const summary = { $id: BASE + 'health-summary.schema.json', title: 'cam-proxy health summary, schema 1', ...obj(summaryProps, ['schema', 'generatedAt', 'version', 'ok', 'problemCount', 'items']) };
  // Spec §8.5: over 192 KiB the proxy sends the header, items and per camera
  // only camera + items, with truncated: true.
  const truncated = {
    $id: BASE + 'health-summary-truncated.schema.json', title: 'cam-proxy health summary, schema 1, truncated',
    ...obj({
      schema: { const: 1 }, generatedAt: int(), version: str(64), ok: bool, problemCount: int(), items,
      cameras: arr(obj({ camera, items }, ['camera', 'items']), 64),
    }, ['schema', 'generatedAt', 'version', 'ok', 'problemCount', 'items']),
  };

  // --- the envelope and the messages (spec §8.4) ------------------------------
  const envelopeProps = (type: S, body: S, o: { sig?: boolean; re?: boolean } = {}): Record<string, S> => ({
    v: { const: 1 }, type, id: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' }, seq: int(1), ts: int(), body,
    ...(o.re !== false ? { re: { type: 'string', maxLength: 40 } } : {}),
    ...(o.sig ? { sig: b64(100) } : {}),
  });
  const message = (name: string, body: S, o: { sig?: boolean; re?: 'required' | 'optional' | 'none' } = {}): S => {
    const props = envelopeProps({ const: name }, body, { sig: o.sig, re: o.re !== 'none' });
    const required = ['v', 'type', 'id', 'seq', 'ts', 'body', ...(o.sig ? ['sig'] : []), ...(o.re === 'required' ? ['re'] : [])];
    const optional = Object.keys(props).filter((k) => !required.includes(k));
    return { $id: BASE + `${name}.schema.json`, title: `cams-admin v1 ${name}`, ...obj(props, required, optional) };
  };
  const nonce: S = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' };
  const summaryRef = (name: string): S => (strict ? { $ref: `${name}.schema.json` } : { type: 'object' });
  const proxyInfo = obj({
    startedAt: nullable(int()), uptimeS: nullable(num), configSchema: nullable(int()),
    tls: nullable(obj({ site: str(63), caFingerprint: arr(fp, 2) }, ['site', 'caFingerprint'])),
    publicUrl: nullable(str(300)),
  }, []);
  const heartbeatBody: S = {
    ...obj({ summary: { type: 'object' }, proxy: proxyInfo, truncated: bool }, ['summary']),
    // The summary's own checks run separately at run time (an unreadable
    // summary is stored as such, never a closed connection); strict picks
    // the full or the truncated shape.
    ...(strict ? {
      if: { properties: { truncated: { const: true } }, required: ['truncated'] },
      then: { properties: { summary: summaryRef('health-summary-truncated') } },
      else: { properties: { summary: summaryRef('health-summary') } },
    } : {}),
  };

  const schemas: Record<string, S> = {
    envelope: {
      $id: BASE + 'envelope.schema.json', title: 'cams-admin v1 envelope (any message)',
      type: 'object',
      properties: {
        // Lenient: any integer v and any type name, so the server can answer
        // unsupported_version / unsupported_type; strict: v1 messages only.
        v: strict ? { const: 1 } : { type: 'integer' },
        type: strict ? { enum: [...MESSAGE_TYPES] } : { type: 'string', pattern: '^[a-z][a-z.]{0,31}$' }, id: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
        seq: int(1), ts: int(), re: { type: 'string', maxLength: 40 }, body: { type: 'object' }, sig: b64(100),
      },
      required: ['v', 'type', 'id', 'seq', 'ts', 'body'],
      ...(strict ? { additionalProperties: false } : {}),
    },
    challenge: message('challenge', obj({ connId: id('con'), nonce, serverTime: int(), serverKeyId: fp }, ['connId', 'nonce', 'serverTime']), { sig: true, re: 'none' }),
    hello: message('hello', obj({
      proxyId: id('prx'), keyId: id('key'), connId: id('con'), nonce, ts: int(), version: str(64), capabilities: arr(str(32), 16),
    }, ['proxyId', 'keyId', 'connId', 'nonce', 'ts']), { sig: true, re: 'none' }),
    welcome: message('welcome', obj({ heartbeatS: int(1), offlineAfterS: int(1), maxMessageBytes: int(1), serverTime: int() }, ['heartbeatS', 'offlineAfterS', 'maxMessageBytes', 'serverTime']), { re: 'none' }),
    heartbeat: message('heartbeat', heartbeatBody, { re: 'none' }),
    ack: message('ack', obj({ nextInS: int(1) }, ['nextInS']), { re: 'required' }),
    error: message('error', obj({ code: str(64), message: str(), retryAfterS: int(0) }, ['code'], ['retryAfterS']), { re: 'optional' }),
    bye: message('bye', obj({ reason: str(64) }, ['reason']), { re: 'none' }),
    'enroll-request': {
      $id: BASE + 'enroll-request.schema.json', title: 'POST /proxy/v1/enroll request',
      ...obj({
        v: { const: 1 }, code: str(64), publicKey: b64(100), proof: b64(100),
        proxy: obj({ version: str(64), cameraIds: arr(str(64), 64) }, []),
      }, ['v', 'code', 'publicKey', 'proof']),
    },
    'enroll-response': {
      $id: BASE + 'enroll-response.schema.json', title: 'POST /proxy/v1/enroll 201 answer',
      ...obj({
        v: { const: 1 }, proxyId: id('prx'), keyId: id('key'), account: str(32), connectUrl: { type: 'string', pattern: '^wss?://' },
        serverKeys: arr(b64(100), 4, { minItems: 1 }), heartbeatS: int(1),
      }, ['v', 'proxyId', 'keyId', 'account', 'connectUrl', 'serverKeys', 'heartbeatS']),
    },
    'health-summary': summary,
    'health-summary-truncated': truncated,
  };
  if (strict) for (const s of Object.values(schemas)) s.$id = (s.$id as string).replace(BASE, BASE + 'strict/');
  return Object.fromEntries(Object.entries(schemas).map(([k, v]) => [k, { $schema: 'https://json-schema.org/draft/2020-12/schema', ...v }]));
}

export const MESSAGE_TYPES = ['challenge', 'hello', 'welcome', 'heartbeat', 'ack', 'error', 'bye'] as const;
// Reserved for P2/P3: defined, not implemented; answered with unsupported_type.
export const RESERVED_TYPES = ['command', 'result', 'event', 'key.rotate'] as const;
