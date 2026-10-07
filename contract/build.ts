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

  // --- P2: commands, results, events, managed tokens (migration spec §7, §10) ---
  const cmdId = id('cmd');
  const tokId = id('tok');
  const hash: S = { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' };
  const label: S = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[^\\u0000-\\u001f\\u007f]+$' };
  const commandBody = obj({
    proxyId: id('prx'), connId: id('con'), cmdId, exp: int(), actor: str(),
    command: strict ? { type: 'string', enum: [...WIRE_COMMANDS] } : { type: 'string', pattern: '^[a-z][a-z.]{0,31}$' },
    // The command's own args schema (commands/<name>.args) checks the rest.
    args: { type: 'object', properties: { v: int(1) }, required: ['v'] },
    // tokens.apply only: the set only removes tokens from the proxy's current
    // set (nothing added or changed). The proxy verifies the claim; a true
    // one is accepted while paused and without an allow entry (never with
    // the env switch off). Optional: older proxies ignore it.
    revocationOnly: bool,
  }, ['proxyId', 'connId', 'cmdId', 'exp', 'actor', 'command', 'args'], ['revocationOnly']);
  const resultCore: Record<string, S> = {
    proxyId: id('prx'), connId: id('con'), cmdId, phase: en(['received', 'done']),
    status: en(['ok', 'failed', 'conflict', 'refused']), code: str(64), retryAfterS: int(0), duplicate: bool, result: { type: 'object' },
  };
  const resultBody: S = {
    ...obj(resultCore, ['proxyId', 'connId', 'cmdId', 'phase'], ['status', 'code', 'retryAfterS', 'duplicate', 'result']),
    // done needs a status (both modes: a result without one is unusable).
    if: { properties: { phase: { const: 'done' } }, required: ['phase'] }, then: { properties: { status: resultCore.status }, required: ['status'] },
  };
  const eventBody = obj({ ...resultCore, kind: en(['command.done']), phase: { const: 'done' } },
    ['proxyId', 'connId', 'kind', 'cmdId', 'phase', 'status'], ['code', 'retryAfterS', 'duplicate', 'result']);
  const tokensArgs = obj({
    v: { const: 1 }, revision: int(1),
    tokens: arr(obj({ id: tokId, kind: en(['client', 'admin']), hash, label, retireAt: nullable(int()) }, ['id', 'kind', 'hash', 'label', 'retireAt']), 64),
  }, ['v', 'revision', 'tokens']);
  const tokensResult = obj({ revision: int(), applied: bool, stale: bool, client: int(), admin: int(), blocked: arr(tokId, 64) }, ['revision', 'applied', 'stale']);
  const commandsInfo = obj({
    enabled: bool, paused: bool, pauseReason: nullable(str()), allow: arr(strict ? { type: 'string', enum: [...ALLOW_ENTRIES] } : str(64), 32), seenWindow: int(),
  }, ['enabled', 'paused', 'allow']);
  const tokensInfo = obj({ revision: int(), client: int(), admin: int(), blocked: arr(tokId, 64) }, ['revision']);

  const proxyInfo = obj({
    startedAt: nullable(int()), uptimeS: nullable(num), configSchema: nullable(int()),
    tls: nullable(obj({ site: str(63), caFingerprint: arr(fp, 2) }, ['site', 'caFingerprint'])),
    publicUrl: nullable(str(300)),
    // P2, optional in both modes (a P1 heartbeat stays valid).
    commands: commandsInfo, tokens: tokensInfo, configRevision: nullable(hash),
  }, [], ['commands', 'tokens', 'configRevision']);
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

  // --- P3: remote configuration (migration spec §8; "The P3 contract") ---------
  const rev: S = { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' };
  const path: S = { type: 'string', pattern: PATH_PATTERN };
  const camId: S = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,31}$' };
  const leafValue: S = { anyOf: [bool, { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 }, { type: 'string', maxLength: 512 }] };
  const anyValue: S = { anyOf: [bool, num, { type: 'string', maxLength: 4096 }, { type: 'null' }] };
  const source = en(['default', 'file', 'override', 'env']);
  const restart = en(['restart', 'process']);
  const change = obj({ path, from: anyValue, to: anyValue, sourceFrom: source, sourceTo: source, restart }, ['path', 'sourceFrom', 'sourceTo'], ['from', 'to', 'restart']);
  const writeOk = (extra: Record<string, S> = {}, req: string[] = []) => obj(
    { dryRun: bool, baseRevision: rev, revision: rev, changes: arr(change, 128), unchanged: arr(path, 64), ...extra },
    ['dryRun', 'baseRevision', 'revision', 'changes', ...req], ['unchanged', ...Object.keys(extra).filter((k) => !req.includes(k))],
  );
  const pathState = obj({ v: anyValue, s: source }, ['s'], ['v']);
  const configFailed = obj({ paths: arr(obj({ path: str(200), code: str(64), detail: str() }, ['path', 'code'], ['detail']), 128) }, ['paths']);
  const configConflict = obj({ revision: rev, current: { type: 'object', propertyNames: { pattern: PATH_PATTERN }, additionalProperties: pathState, maxProperties: 128 } }, ['revision', 'current']);
  const settable = obj({ type: en(['integer', 'boolean', 'string']), min: num, max: num, oneOf: arr(int(), 64), enum: arr(str(64), 64), pattern: str(400), optional: bool, dir: en(['less', 'more']) }, ['type'], ['min', 'max', 'oneOf', 'enum', 'pattern', 'optional', 'dir']);
  const viewPath = obj({ v: anyValue, s: source, r: restart, p: bool, n: anyValue, by: obj({ cmdId, actor: str(), at: int() }, ['cmdId', 'actor', 'at']) }, ['s'], ['v', 'r', 'p', 'n', 'by']);
  const p3Args: Record<(typeof P3_COMMANDS)[number], S> = {
    'config.get': obj({ v: { const: 1 } }, ['v']),
    'config.set': obj({ v: { const: 1 }, dryRun: bool, baseRevision: rev, set: { type: 'object', minProperties: 1, maxProperties: 64, propertyNames: { pattern: PATH_PATTERN }, additionalProperties: leafValue } }, ['v', 'dryRun', 'baseRevision', 'set']),
    'config.unset': obj({ v: { const: 1 }, dryRun: bool, baseRevision: rev, paths: arr(path, 64, { minItems: 1, uniqueItems: true }) }, ['v', 'dryRun', 'baseRevision', 'paths']),
    'config.rollback': obj({ v: { const: 1 }, dryRun: bool, cmdId }, ['v', 'dryRun', 'cmdId']),
    'camera.action': {
      ...obj({
        v: { const: 1 }, camera: nullable(camId), action: strict ? { type: 'string', enum: [...REMOTE_ACTIONS] } : str(32),
        input: obj({ kind: str(32, { minLength: 1 }), camera: bool }, ['kind'], ['camera']),
      }, ['v', 'camera', 'action'], ['input']),
      // camera is null only for retention-run (required otherwise); input only for inventory.
      allOf: [
        { if: { properties: { action: { const: 'retention-run' } }, required: ['action'] }, then: { properties: { camera: { type: 'null' } } }, else: { properties: { camera: camId } } },
        { if: { properties: { input: { type: 'object' } }, required: ['input'] }, then: { properties: { action: { const: 'inventory' } } } },
      ],
    },
    'camera.name.set': obj({ v: { const: 1 }, camera: camId, name: { type: 'string', minLength: 1, maxLength: 64, pattern: CAMERA_NAME_PATTERN } }, ['v', 'camera', 'name']),
    'proxy.restart': obj({ v: { const: 1 } }, ['v']),
  };
  const p3Results: Record<(typeof P3_COMMANDS)[number], S> = {
    'config.get': obj({
      revision: rev, schema: int(), cameras: arr(camId, 256), omittedCameras: arr(camId, 256),
      paths: { type: 'object', propertyNames: { pattern: PATH_PATTERN }, additionalProperties: viewPath, maxProperties: 4096 },
      settable: { type: 'object', additionalProperties: settable, maxProperties: 512 },
    }, ['revision', 'paths', 'settable'], ['schema', 'cameras', 'omittedCameras']),
    'config.set': { anyOf: [writeOk(), configFailed, configConflict] },
    'config.unset': { anyOf: [writeOk(), configFailed, configConflict] },
    'config.rollback': { anyOf: [writeOk({ of: cmdId }, ['of']), configFailed, configConflict] },
    'camera.action': obj({ action: str(32), camera: nullable(camId), httpStatus: int(100), answer: nullable({ type: 'object' }), clamped: bool, verified: bool, mismatch: arr(str(64), 32) }, ['action', 'camera', 'httpStatus', 'answer'], ['clamped', 'verified', 'mismatch']),
    'camera.name.set': obj({ camera: camId, requested: str(64), name: str(64), verified: bool }, ['camera', 'requested', 'name', 'verified']),
    'proxy.restart': obj({ restartAt: int() }, ['restartAt']),
  };
  const p3Schemas: Record<string, S> = {};
  for (const c of P3_COMMANDS) {
    p3Schemas[`commands/${c}.args`] = { $id: BASE + `commands/${c}.args.schema.json`, title: `${c} args v1`, ...p3Args[c] };
    p3Schemas[`commands/${c}.result`] = { $id: BASE + `commands/${c}.result.schema.json`, title: `${c} result v1`, ...p3Results[c] };
  }

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
    command: message('command', commandBody, { sig: true, re: 'none' }),
    result: message('result', resultBody, { sig: true, re: 'required' }),
    event: message('event', eventBody, { sig: true, re: 'none' }),
    'commands/tokens.apply.args': { $id: BASE + 'commands/tokens.apply.args.schema.json', title: 'tokens.apply args v1', ...tokensArgs },
    'commands/tokens.apply.result': { $id: BASE + 'commands/tokens.apply.result.schema.json', title: 'tokens.apply result v1', ...tokensResult },
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
    ...p3Schemas,
  };
  if (strict) for (const s of Object.values(schemas)) s.$id = (s.$id as string).replace(BASE, BASE + 'strict/');
  return Object.fromEntries(Object.entries(schemas).map(([k, v]) => [k, { $schema: 'https://json-schema.org/draft/2020-12/schema', ...v }]));
}

export const MESSAGE_TYPES = ['challenge', 'hello', 'welcome', 'heartbeat', 'ack', 'error', 'bye', 'command', 'result', 'event'] as const;
// Reserved: defined, not implemented; answered with unsupported_type.
export const RESERVED_TYPES = ['key.rotate'] as const;

// The command names on the wire (strict enum). P2 implements tokens.apply.
export const WIRE_COMMANDS = ['tokens.apply', 'config.get', 'config.set', 'config.unset', 'config.rollback', 'camera.action', 'camera.name.set', 'proxy.restart'] as const;
// The camera actions a proxy may allow for remote use (camera.action:<a>).
export const REMOTE_ACTIONS = [
  'camera-test', 'onvif-resubscribe', 'camera-ftp-test', 'poe-switch-read', 'inventory', 'inventory-cancel', 'retention-run', 'restart',
  'camera-reboot', 'camera-powercycle', 'camera-ftp-setup', 'camera-ftp-off', 'camera-ntp-set', 'camera-cert-push',
] as const;
// The proxy's allow-list entries (camsAdmin.allowCommands); anything else is a load error on the proxy.
export const ALLOW_ENTRIES: readonly string[] = [
  'tokens.apply', 'tokens.apply.admin', 'config.get', 'config.set', 'config.unset', 'config.rollback', 'camera.name.set', 'proxy.restart',
  ...REMOTE_ACTIONS.map((a) => `camera.action:${a}`),
];

// --- P3 ("The P3 contract") ---------------------------------------------------
// The commands P3 implements (all in WIRE_COMMANDS since P2).
export const P3_COMMANDS = ['config.get', 'config.set', 'config.unset', 'config.rollback', 'camera.action', 'camera.name.set', 'proxy.restart'] as const;
// Actions a proxy never runs for cams-admin, whatever its allow-list says.
export const NEVER_REMOTE_ACTIONS = [
  'find-camera', 'camera-address', 'camera-trust-clear', 'tls-ca-rotate', 'tls-ca-drop-previous', 'archive-clear', 'inventory-repair', 'camera-poe-on', 'restart-proxy',
] as const;
// Remote actions the UIs group and warn about (with proxy.restart); the journal budget counts them.
export const DISRUPTIVE_ACTIONS = ['restart', 'camera-reboot', 'camera-powercycle', 'camera-ftp-setup', 'camera-ftp-off', 'camera-ntp-set', 'camera-cert-push'] as const;
// A setting's dotted path, as GET /control/config names it (no "_": never __proto__).
export const PATH_PATTERN = '^[a-z][A-Za-z0-9]{0,31}(\\.[a-z0-9][A-Za-z0-9-]{0,31}){0,5}$';
// Coordinator ruling (security review I4): capture/feature on-off switches
// and health thresholds are local only in P3 — a compromised cams-admin must
// not be able to blind a proxy silently, and ftp.enabled=true opens ports
// (network exposure needs Klaus). In `denied`, never in `remote`.
export const LOCAL_ONLY = [
  'stills.enabled', 'events.poll.enabled', 'ftp.enabled', 'ftp.stalledHours', 'archive.enabled', 'archive.warnPercent', 'health.diskPercent', 'health.tempC', 'host.stats',
  'analytics.kinds.person', 'analytics.kinds.vehicle', 'analytics.kinds.pet', 'analytics.googleVision.enabled',
  'cameras.*.stills.enabled', 'cameras.*.ftp.enabled', 'cameras.*.events.poll.enabled', 'cameras.*.analytics.kinds.person', 'cameras.*.analytics.kinds.vehicle', 'cameras.*.analytics.kinds.pet',
] as const;
// A key or dotted path that looks secret: cams-admin drops such paths from a
// stored view and such keys from an action's answer (the proxy scrubs too).
// A camera name (camera.name.set, and cameras.*.name from cams-admin):
// 1–64 characters, no C0/C1 controls, no bidi controls, no line or paragraph
// separators, no zero-width characters (security review M3). A `u` regex.
export const CAMERA_NAME_PATTERN = '^[^\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff]{1,64}$';
export const SECRET_KEY_PATTERN = 'pem|key|password|passwd|secret|token|cookie';
// contract/v1/remote-settable.json: `remote` is the upper bound of what any
// proxy may let cams-admin set; `narrow` the paths that may only move one way
// (less spending, more data kept); `denied` documents what is never remote.
export const REMOTE_SETTABLE: { v: 1; remote: string[]; narrow: Record<string, 'less' | 'more'>; denied: string[] } = {
  v: 1,
  remote: [
    'stills.stream', 'stills.intervalS', 'stills.size', 'stills.quality', 'stills.maxGB',
    'previews.tileSize', 'previews.grid', 'previews.quality', 'previews.maxGB',
    'events.onvif.subscribeMin', 'events.onvif.pullTimeoutS', 'events.poll.intervalS', 'events.poll.afterOnvifDownS', 'events.maxOpenMin',
    'retention.stillsDays', 'retention.previewsDays', 'retention.clipsDays', 'retention.eventsDays', 'retention.auditDays', 'retention.streamLogDays', 'retention.intervalMin',
    'composition.concurrent', 'sse.maxClients', 'sse.queuePerClient', 'sse.pingS', 'recordings.cacheMB',
    'ftp.stream', 'ftp.maxGB',
    'analytics.googleVision.monthlyLimit', 'analytics.googleVision.dailyCap', 'analytics.googleVision.checksPerDay', 'analytics.googleVision.perCameraDailyCap',
    'cameras.*.name', 'cameras.*.statusPollS', 'cameras.*.stills.stream', 'cameras.*.stills.intervalS',
    'cameras.*.ftp.stream',
  ],
  narrow: {
    'analytics.googleVision.monthlyLimit': 'less', 'analytics.googleVision.dailyCap': 'less',
    'analytics.googleVision.checksPerDay': 'less', 'analytics.googleVision.perCameraDailyCap': 'less',
    'retention.stillsDays': 'more', 'retention.previewsDays': 'more', 'retention.clipsDays': 'more', 'retention.eventsDays': 'more',
    'retention.auditDays': 'more', 'retention.streamLogDays': 'more',
    'stills.maxGB': 'more', 'previews.maxGB': 'more', 'ftp.maxGB': 'more',
  },
  denied: [
    'server', 'go2rtc', 'storage', 'ftp.port', 'ftp.passive', 'ftp.tls', 'ftp.publicHost', 'ftp.certFile', 'ftp.keyFile', 'tls', 'composition.font', 'ntp.server',
    'poeSwitch', 'camsAdmin', 'cameras.*.id', 'cameras.*.host', 'cameras.*.protocol', 'cameras.*.tlsName', 'cameras.*.user', 'cameras.*.onvifPort', 'cameras.*.rtspPort',
    'cameras.*.baichuanPort', 'cameras.*.poeSwitch', 'cameras.*.ftp.user', 'cameras.*.webUiUrl', 'cameras.*.storage',
    // Local only in P3 (coordinator ruling, security review I4): capture and listener switches, health thresholds.
    ...LOCAL_ONLY,
  ],
};
