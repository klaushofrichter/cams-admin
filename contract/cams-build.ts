// Builds the cams-v1 contract: the service API between a cams instance and
// cams-admin (migration spec §9.2; the plans' section "The cams-v1 contract").
// Two modes as contract/build.ts: lenient (what a receiver accepts at run
// time: open objects, plain strings for enums) and strict (closed objects,
// every listed field required, enums enforced; for the tests of both repos).
// `npm run contract:make` writes contract/cams-v1/ from this file; cams
// vendors that folder. The fixtures and vectors are deterministic (fixed
// time, nonces and seeds), so a re-run changes nothing unless the contract does.
import { fingerprint, keyFromSeed, privateFromB64, sign, signEnvelope, signedText, camsRequestText, camsResponseText, sha256hex } from '../server/crypto/ed25519';
import { jcs } from '../server/crypto/jcs';
import { SITE_PATTERN } from './build';
import { DEFAULT_VIEWER_LINK_URL, viewerFingerprint, viewerLink } from '../server/viewerTokens/crypto';

export type Mode = 'lenient' | 'strict';
type S = Record<string, unknown>;

const BASE = 'https://cams-admin.skylar.technology/contract/cams-v1/';
const TEXT = 200;

// The values cams holds until an account admin confirms (M §9.7, ruling R4-7).
export const TRUST_FIELDS = ['proxyUrl', 'caFingerprints', 'proxyTlsServername', 'host', 'protocol', 'tlsServername'] as const;
export type TrustField = (typeof TRUST_FIELDS)[number];
export const HELD_PROXY_FIELDS = ['proxyUrl', 'caFingerprints', 'proxyTlsServername'] as const;
export const CAMS_ID_PATTERN = '^[a-z0-9][a-z0-9-]{0,31}$';
export const REVISION_PATTERN = '^r:[0-9a-f]{16}$';

export const CAMS_SCHEMA_NAMES = ['enroll-request', 'enroll-response', 'snapshot', 'tokens-request', 'tokens-response', 'retire-request', 'retire-response', 'report-request', 'report-response', 'fleet-response', 'error'] as const;

export function buildCamsSchemas(mode: Mode): Record<string, S> {
  const strict = mode === 'strict';
  const str = (max = TEXT, extra: S = {}): S => ({ type: 'string', maxLength: max, ...extra });
  const int = (min = 0, extra: S = {}): S => ({ type: 'integer', minimum: min, ...extra });
  const bool: S = { type: 'boolean' };
  const nullable = (s: S): S => ({ anyOf: [s, { type: 'null' }] });
  const en = (values: readonly string[]): S => (strict ? { type: 'string', enum: [...values] } : str(64));
  const arr = (items: S, maxItems: number, extra: S = {}): S => ({ type: 'array', items, maxItems, ...extra });
  const obj = (props: Record<string, S>, required: string[], optional: string[] = []): S => ({
    type: 'object',
    properties: props,
    required: strict ? Object.keys(props).filter((k) => !optional.includes(k)) : required,
    ...(strict ? { additionalProperties: false } : {}),
  });
  const id = (prefix: string): S => ({ type: 'string', pattern: `^${prefix}_[0-9A-HJKMNP-TV-Z]{20}$` });
  const b64 = (len: number): S => ({ type: 'string', maxLength: len, pattern: '^[A-Za-z0-9+/]+={0,2}$' });
  const fp: S = { type: 'string', pattern: '^SHA256:[0-9A-F]{64}$' };
  const camsId: S = { type: 'string', pattern: CAMS_ID_PATTERN };
  const revision: S = { type: 'string', pattern: REVISION_PATTERN };
  const hash: S = { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' };
  const tokenState = en(['pending', 'active', 'retiring', 'revoked']);
  const all = (props: Record<string, S>) => obj(props, Object.keys(props));

  // --- the snapshot ------------------------------------------------------------
  const user = all({ email: str(254), role: en(['admin', 'viewer']), disabled: bool });
  const tokenRef = all({ id: id('tok'), kind: en(['client', 'admin']), state: tokenState, retireAt: nullable(int()) });
  // Camera moves: proxies[].site (the TLS site name the registry holds, pinned to cam-proxy's tls.site pattern) and cameras[].moveId (the
  // move that currently holds the camera, else null) are required in strict and optional at run time, so an older snapshot stays readable.
  const proxyProps: Record<string, S> = {
    id: id('prx'), name: str(32), displayName: str(), url: nullable(str(512)), adminUiUrl: nullable(str(512)), tlsServername: nullable(str(253)),
    caFingerprints: arr(fp, 2), tokens: arr(tokenRef, 64), site: nullable({ type: 'string', pattern: SITE_PATTERN }),
  };
  const proxy = obj(proxyProps, Object.keys(proxyProps).filter((k) => k !== 'site'));
  const cameraProps: Record<string, S> = {
    id: id('cam'), camsId, name: str(), proxyId: nullable(id('prx')), proxyCameraId: nullable(str(32)), host: nullable(str(255)),
    protocol: nullable(en(['https', 'http'])), tlsServername: nullable(str(253)), cameraUser: nullable(str(64)), webUiUrl: nullable(str(512)), webUiNote: nullable(str(120)),
    moveId: nullable(id('mv')),
    // The attestation that cams-admin made this camera's move (cams rules A/B): signed with the snapshot, expires with expiresAt (ms).
    move: nullable(all({ id: id('mv'), sourceProxyId: id('prx'), targetProxyId: id('prx'), expiresAt: int() })),
  };
  const camera = obj(cameraProps, Object.keys(cameraProps).filter((k) => k !== 'moveId' && k !== 'move'));
  // Viewer tokens (snapshot format 4, design 2026-11-05): the tokens valid at generatedAt that include this account, sorted by id.
  // Only the fingerprint, never the token. Required in strict, optional at run time (an older snapshot, an older cams).
  const viewerToken = all({ id: id('vtk'), name: str(64), fingerprint: hash, expiresAt: int() });
  const accountProps: Record<string, S> = { id: id('acc'), name: str(32), displayName: str(), revision: int(0), users: arr(user, 500), proxies: arr(proxy, 64), cameras: arr(camera, 256), viewerTokens: arr(viewerToken, 64) };
  const account = obj(accountProps, Object.keys(accountProps).filter((k) => k !== 'viewerTokens'));
  const snapshot = all({
    v: { const: 1 }, type: { const: 'cams-config' }, instance: all({ id: id('cms'), name: str(32), rotateBefore: nullable(int()) }),
    revision, generatedAt: int(), accounts: arr(account, 64), sig: { type: 'string', pattern: '^[A-Za-z0-9+/]{86}==$' },
  });

  // --- tokens ----------------------------------------------------------------
  const tokensRequest = all({ v: { const: 1 }, proxyId: id('prx'), kind: en(['client', 'admin']), hash });
  const tokensResponse = all({ tokenId: id('tok'), state: en(['pending', 'active', 'retiring']), label: str(64) });
  const retireRequest = obj({ v: { const: 1 }, hours: int(1, { maximum: 168 }) }, ['v'], ['hours']);
  const retireResponse = all({ tokenId: id('tok'), state: { const: 'retiring' }, retireAt: int() });

  // --- the report --------------------------------------------------------------
  const trustEntry = all({ accountId: id('acc'), camsId, fields: arr(en(TRUST_FIELDS), TRUST_FIELDS.length, { minItems: 1 }) });
  const reportRequest = obj({
    v: { const: 1 }, mode: en(['file', 'shadow', 'cams-admin']), version: str(64),
    appliedRevision: nullable(revision), cacheVerifiedAt: nullable(int()), lastPullAt: nullable(int()),
    held: arr(trustEntry, 200), keptOld: arr(trustEntry, 200),
    // Camera moves: proxies cams holds because their address or CA changed (never a value), for the trusted-proxy banner. Optional in strict too.
    heldProxies: arr(all({ accountId: id('acc'), proxyId: id('prx'), fields: arr(en(HELD_PROXY_FIELDS), HELD_PROXY_FIELDS.length, { minItems: 1, uniqueItems: true }) }), 64),
    shadow: nullable(all({ accountId: nullable(id('acc')), differences: int(), items: arr(str(200), 20) })),
    tokens: all({ managed: int(), pending: int(), legacy: int() }),
    problems: arr(obj({ code: str(64), accountId: nullable(id('acc')), detail: str(200) }, ['code'], ['accountId']), 50),
    // Viewer tokens: the newest use per token since the last report (ids and times only). Optional in strict too.
    viewerTokens: arr(all({ id: id('vtk'), lastUsedAt: int() }), 200),
  }, ['v', 'mode'], ['heldProxies', 'viewerTokens']);
  const reportResponse = all({ changed: bool, revision });

  // --- one account's fleet, for its admins' MCP tools (read only, never a token, key or fingerprint) ---
  const place = nullable(all({ url: str(512), scope: en(['loopback', 'private', 'public']), note: nullable(str(120)) }));
  const fleetProxy = all({
    name: str(32), displayName: str(), state: en(['pending', 'never-connected', 'online', 'offline', 'stopped', 'rejected', 'revoked']), version: nullable(str(64)),
    ok: nullable(bool), problemCount: nullable(int()), reportedAt: nullable(int()), gui: place,
    problems: arr(all({ id: nullable(str(64)), label: nullable(str(120)), text: nullable(str(240)), camera: nullable(camsId) }), 20),
    cameras: arr(all({ id: camsId, name: str(), online: nullable(bool) }), 256),
  });
  const heldCamera = all({ camera: camsId, fields: arr(en(TRUST_FIELDS), TRUST_FIELDS.length, { minItems: 1 }) });
  const fleetViewer = all({
    name: str(32), displayName: str(), thisViewer: bool, address: place, held: arr(heldCamera, 50), keptOld: arr(heldCamera, 50),
    heldProxies: arr(all({ proxy: str(), fields: arr(en(HELD_PROXY_FIELDS), HELD_PROXY_FIELDS.length, { minItems: 1 }) }), 50), heldTotal: int(),
  });
  const fleetMove = all({
    id: id('mv'), camera: nullable(camsId), cameraName: nullable(str()), source: nullable(str()), target: nullable(str()), phase: str(32), reason: nullable(str(64)),
    bytesTotal: nullable(int()), bytesDone: nullable(int()), rateBps: nullable({ type: 'number', minimum: 0 }), etaS: nullable({ type: 'number', minimum: 0 }),
    chunks: all({ pending: int(), copied: int(), verified: int(), skipped: int(), failed: int(), abandoned: int() }),
    createdAt: int(), updatedAt: int(), endedAt: nullable(int()),
  });
  // PoE switches (design 2026-11-07-poe-switches-design.md; the cams MCP's switch_list and camera_power): by name,
  // never an id, serial, firmware or password. Required in strict, optional at run time (an older cams-admin).
  const port = int(1, { maximum: 64 });
  const fleetSwitch = all({
    name: str(60), model: en(['sscpoe-web']), address: place, proxy: nullable(str()), state: en(['pending', 'active']), readAt: nullable(int()), ports: port,
    problems: arr(all({ code: en(['chained_switch']), port, cameras: int(2) }), 64),
  });
  const fleetPower = all({
    camera: camsId, cameraName: nullable(str()), kind: en(['poe', 'data-only', 'adapter', 'unknown']), switch: nullable(str(60)), port: nullable(port),
    watts: nullable({ type: 'number', minimum: 0 }), verifiedAt: nullable(int()), notSeen: bool,
    lastCycle: nullable(all({ state: en(['running', 'ok', 'failed']), requestedAt: nullable(int()), finishedAt: nullable(int()), code: nullable(str(64)), reason: nullable(str()) })),
  });
  const fleetProps: Record<string, S> = {
    v: { const: 1 }, type: { const: 'cams-fleet' }, accountId: id('acc'), generatedAt: int(),
    proxies: arr(fleetProxy, 64), notRouted: int(), viewers: arr(fleetViewer, 32), moves: arr(fleetMove, 50),
    switches: arr(fleetSwitch, 64), cameraPower: arr(fleetPower, 256),
  };
  const fleetResponse = obj(fleetProps, Object.keys(fleetProps).filter((k) => k !== 'switches' && k !== 'cameraPower'));

  // --- enrollment and errors -----------------------------------------------------
  const enrollRequest = obj({ v: { const: 1 }, code: str(64), publicKey: b64(100), proof: b64(100), camsVersion: str(64) }, ['v', 'code', 'publicKey', 'proof']);
  const enrollResponse = all({
    v: { const: 1 }, instanceId: id('cms'), instanceName: str(32), keyId: id('key'), accounts: arr(str(32), 64),
    serverKeys: arr(b64(100), 4, { minItems: 1 }), serverKeyFingerprints: arr(fp, 4, { minItems: 1 }), apiUrl: str(512, { pattern: '^https?://' }),
  });
  const error = obj({ error: str(64), field: str(64), retryAfterS: int(0), serverTime: int(), tokenId: id('tok') }, ['error'], ['field', 'retryAfterS', 'serverTime', 'tokenId']);

  const schemas: Record<string, S> = {
    'enroll-request': { title: 'POST /cams/v1/enroll request', ...enrollRequest },
    'enroll-response': { title: 'POST /cams/v1/enroll 201 answer', ...enrollResponse },
    snapshot: { title: 'GET /cams/v1/config 200 answer: the signed snapshot', ...snapshot },
    'tokens-request': { title: 'POST /cams/v1/tokens request', ...tokensRequest },
    'tokens-response': { title: 'POST /cams/v1/tokens 200/201 answer', ...tokensResponse },
    'retire-request': { title: 'POST /cams/v1/tokens/:tokenId/retire request', ...retireRequest },
    'retire-response': { title: 'POST /cams/v1/tokens/:tokenId/retire 200 answer', ...retireResponse },
    'report-request': { title: 'POST /cams/v1/report request', ...reportRequest },
    'report-response': { title: 'POST /cams/v1/report 200 answer', ...reportResponse },
    'fleet-response': { title: 'GET /cams/v1/accounts/:accountId/fleet 200 answer', ...fleetResponse },
    error: { title: 'any /cams/v1 error answer', ...error },
  };
  const base = strict ? BASE + 'strict/' : BASE;
  return Object.fromEntries(Object.entries(schemas).map(([k, v]) => [k, { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: `${base}${k}.schema.json`, ...v }]));
}

// --- fixtures and vectors -------------------------------------------------------------

export const NOW = 1791273600000;
export const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA';
const SEEDS = { server: '02'.repeat(32), cams: 'c4'.repeat(32), other: '03'.repeat(32) };
const fixedId = (prefix: string, n: number) => `${prefix}_${String(n).padStart(20, '0')}`;
export const IDS = {
  instance: fixedId('cms', 1), key: fixedId('key', 1),
  home: fixedId('acc', 1), beta: fixedId('acc', 2),
  pi: fixedId('prx', 1), cluster: fixedId('prx', 2), b1: fixedId('prx', 3),
  cam1: fixedId('cam', 1), cam2: fixedId('cam', 2), bcam1: fixedId('cam', 3),
  tok1: fixedId('tok', 1), tok2: fixedId('tok', 2),
  vtk1: fixedId('vtk', 1),
};
// A fixed fake viewer token (never a real one): cams reproduces its fingerprint and link.
export const VIEWER_TOKEN_VECTOR = 'cav_TestOnlyNotARealToken0';

function keys() {
  return Object.fromEntries(Object.entries(SEEDS).map(([n, seedHex]) => {
    const k = keyFromSeed(seedHex);
    return [n, { seedHex, privateKey: k.privateKeyPkcs8B64, publicKey: k.publicKeySpkiB64, fingerprint: fingerprint(k.publicKeySpkiB64) }];
  })) as Record<keyof typeof SEEDS, { seedHex: string; privateKey: string; publicKey: string; fingerprint: string }>;
}

function unsignedSnapshot(kind: 'two-accounts' | 'empty'): Record<string, unknown> {
  const accounts = kind === 'empty' ? [] : [
    {
      id: IDS.beta, name: 'beta', displayName: 'Beta', revision: 3,
      users: [{ email: 'klaus@example.org', role: 'viewer', disabled: false }],
      viewerTokens: [],
      proxies: [{ id: IDS.b1, name: 'b1', displayName: 'Beta proxy', url: 'https://beta.example.net:8480', adminUiUrl: null, tlsServername: null, caFingerprints: [], tokens: [], site: null }],
      cameras: [{ id: IDS.bcam1, camsId: 'cam1', name: 'Gate', proxyId: IDS.b1, proxyCameraId: 'cam1', host: 'from-proxy', protocol: 'https', tlsServername: null, cameraUser: 'cams', webUiUrl: null, webUiNote: null, moveId: null, move: null }],
    },
    {
      id: IDS.home, name: 'home', displayName: 'Home', revision: 17,
      users: [{ email: 'klaus@example.org', role: 'admin', disabled: false }, { email: 'viewer@example.org', role: 'viewer', disabled: false }],
      viewerTokens: [{ id: IDS.vtk1, name: 'Kitchen tablet', fingerprint: viewerFingerprint(VIEWER_TOKEN_VECTOR), expiresAt: NOW + 7 * 86_400_000 }],
      proxies: [
        { id: IDS.cluster, name: 'cluster', displayName: 'Cluster', url: 'https://proxy.example.net:8480', adminUiUrl: null, tlsServername: 'proxy.example.net',
          caFingerprints: ['SHA256:' + 'A1'.repeat(32)], tokens: [{ id: IDS.tok2, kind: 'admin', state: 'retiring', retireAt: NOW + 86_400_000 }], site: 'garage' },
        { id: IDS.pi, name: 'pi', displayName: 'Pi', url: 'http://127.0.0.1:8480', adminUiUrl: 'http://192.0.2.20:8480', tlsServername: null, caFingerprints: [],
          tokens: [{ id: IDS.tok1, kind: 'client', state: 'active', retireAt: null }], site: null },
      ],
      cameras: [
        { id: IDS.cam1, camsId: 'cam1', name: 'Backyard', proxyId: IDS.pi, proxyCameraId: 'cam1', host: 'from-proxy', protocol: 'https', tlsServername: 'cam1.example.net', cameraUser: 'cams', webUiUrl: null, webUiNote: null, moveId: null, move: null },
        { id: IDS.cam2, camsId: 'cam2', name: 'Driveway', proxyId: IDS.cluster, proxyCameraId: 'cam2', host: '192.0.2.31', protocol: 'https', tlsServername: null, cameraUser: 'cams', webUiUrl: 'https://192.0.2.31', webUiNote: 'LAN only', moveId: 'mv_0123456789ABCDEFGHJK',
          move: { id: 'mv_0123456789ABCDEFGHJK', sourceProxyId: IDS.pi, targetProxyId: IDS.cluster, expiresAt: NOW + 86_400_000 } },
      ],
    },
  ];
  return {
    v: 1, type: 'cams-config', instance: { id: IDS.instance, name: 'cluster', rotateBefore: null },
    revision: kind === 'empty' ? 'r:0000000000000000' : 'r:0123456789abcdef', generatedAt: NOW, accounts,
  };
}

const fleet = () => ({
  v: 1, type: 'cams-fleet', accountId: IDS.home, generatedAt: NOW, notRouted: 1,
  proxies: [{
    name: 'pi', displayName: 'Pi', state: 'online', version: '2026.10.07.1', ok: false, problemCount: 1, reportedAt: NOW,
    gui: { url: 'http://10.20.30.40:8480/', scope: 'private', note: 'Local network address: only reachable from inside that network.' },
    problems: [{ id: 'disk', label: 'Disk', text: '91% full', camera: null }, { id: 'stream', label: 'Stream', text: 'not connected', camera: 'cam1' }],
    cameras: [{ id: 'cam1', name: 'Backyard', online: true }],
  }],
  viewers: [{
    name: 'cluster', displayName: 'Cluster', thisViewer: true, address: { url: 'https://cams.example.net/', scope: 'public', note: null },
    held: [{ camera: 'cam1', fields: ['host'] }], keptOld: [], heldProxies: [{ proxy: 'Pi', fields: ['proxyUrl'] }], heldTotal: 2,
  }],
  moves: [{
    id: 'mv_0123456789ABCDEFGHJK', camera: 'cam2', cameraName: 'Driveway', source: 'Pi', target: 'Cluster', phase: 'copying', reason: null,
    bytesTotal: 1000, bytesDone: 400, rateBps: 100, etaS: 6, chunks: { pending: 1, copied: 0, verified: 2, skipped: 0, failed: 0, abandoned: 0 },
    createdAt: NOW - 60_000, updatedAt: NOW, endedAt: null,
  }],
  switches: [{
    name: 'GPS-208', model: 'sscpoe-web', address: { url: 'http://192.168.1.217/', scope: 'private', note: 'Local network address: only reachable from inside that network.' },
    proxy: 'Pi', state: 'active', readAt: NOW, ports: 8, problems: [{ code: 'chained_switch', port: 8, cameras: 2 }],
  }],
  cameraPower: [{
    camera: 'cam1', cameraName: 'Backyard', kind: 'poe', switch: 'GPS-208', port: 3, watts: 4.2, verifiedAt: NOW, notSeen: false,
    lastCycle: { state: 'ok', requestedAt: NOW - 30_000, finishedAt: NOW - 10_000, code: null, reason: null },
  }],
});

const report = (mode: 'shadow' | 'cams-admin') => ({
  v: 1, mode, version: '2026.10.07.1', appliedRevision: 'r:0123456789abcdef', cacheVerifiedAt: NOW, lastPullAt: NOW,
  held: mode === 'cams-admin' ? [{ accountId: IDS.home, camsId: 'cam1', fields: ['host'] }] : [],
  keptOld: [],
  heldProxies: mode === 'cams-admin' ? [{ accountId: IDS.home, proxyId: IDS.cluster, fields: ['proxyUrl', 'caFingerprints'] }] : undefined,
  shadow: mode === 'shadow' ? { accountId: IDS.home, differences: 1, items: ['cam2: tlsServername'] } : null,
  tokens: { managed: 2, pending: 0, legacy: mode === 'shadow' ? 2 : 0 },
  problems: mode === 'shadow' ? [] : [{ code: 'snapshot_invalid', accountId: IDS.beta, detail: 'camera 3: protocol' }],
  viewerTokens: mode === 'cams-admin' ? [{ id: IDS.vtk1, lastUsedAt: NOW - 60_000 }] : undefined,
});

export function camsFixtures(): Record<string, unknown> {
  const k = keys();
  const SERVER = privateFromB64(k.server.privateKey);
  const CAMS = privateFromB64(k.cams.privateKey);
  const signed = (m: Record<string, unknown>) => ({ ...m, sig: signEnvelope(SERVER, m) });
  const valid = (schema: string, message: unknown, note: string) => ({ $note: note, schema, message });
  const invalid = (schema: string, message: unknown, note: string) => ({ $note: note, schema, $expect: { strict: 'invalid' }, message });
  const drift = (schema: string, message: unknown, note: string) => ({ $note: note, schema, $expect: { runtime: 'accepted', strict: 'invalid' }, message });
  const two = unsignedSnapshot('two-accounts');
  const withAccount = (patch: (a: Record<string, unknown>) => void) => {
    const s = structuredClone(two) as { accounts: Record<string, unknown>[] };
    patch(s.accounts[1]);
    return signed(s as unknown as Record<string, unknown>);
  };
  const withCamera = (patch: Record<string, unknown>) => {
    const s = structuredClone(two) as { accounts: { cameras: Record<string, unknown>[] }[] };
    Object.assign(s.accounts[1].cameras[0], patch);
    return signed(s as unknown as Record<string, unknown>);
  };
  const code = 'CAC1-7Q2M-K9XD-4HPA-W3ZT-RN6B';
  const tokensReq = { v: 1, proxyId: IDS.pi, kind: 'client', hash: 'sha256:' + '0'.repeat(63) + '1' };
  const longItems = report('shadow');
  longItems.shadow!.items = ['cam2: tlsServername was ' + 'x'.repeat(200)];
  return {
    'valid-snapshot-two-accounts': valid('snapshot', signed(two), 'two accounts sorted by name; the same camsId in both; signed by the vectors server key'),
    'valid-snapshot-empty': valid('snapshot', signed(unsignedSnapshot('empty')), 'an instance that serves no account'),
    'valid-tokens-request': valid('tokens-request', tokensReq, 'a client token hash (lower-case hex)'),
    'valid-tokens-response': valid('tokens-response', { tokenId: IDS.tok1, state: 'pending', label: 'cams cluster' }, ''),
    'valid-retire-request': valid('retire-request', { v: 1, hours: 24 }, ''),
    'valid-retire-response': valid('retire-response', { tokenId: IDS.tok1, state: 'retiring', retireAt: NOW + 86_400_000 }, ''),
    'valid-report-shadow': valid('report-request', report('shadow'), 'shadow mode, one difference named by camsId and field (never a value)'),
    'valid-report-cams-admin': valid('report-request', report('cams-admin'), 'cams-admin mode, one held change and one problem'),
    'valid-report-response': valid('report-response', { changed: true, revision: 'r:0123456789abcdef' }, ''),
    'valid-enroll-request': valid('enroll-request', { v: 1, code, publicKey: k.cams.publicKey, proof: sign(CAMS, signedText.camsEnroll(code, k.cams.publicKey)), camsVersion: '2026.10.07.1' }, 'proof signed by the vectors cams key'),
    'valid-enroll-response': valid('enroll-response', {
      v: 1, instanceId: IDS.instance, instanceName: 'cluster', keyId: IDS.key, accounts: ['home'], serverKeys: [k.server.publicKey],
      serverKeyFingerprints: [k.server.fingerprint], apiUrl: 'https://cams-admin.example.net',
    }, ''),
    'valid-error-clock-skew': valid('error', { error: 'clock_skew', serverTime: NOW }, 'signed like every answer past the header check'),
    'valid-error-pending-exists': valid('error', { error: 'pending_exists', tokenId: IDS.tok1 }, ''),
    'invalid-snapshot-secret-field': invalid('snapshot', withCamera({ password: 'not-a-real-password' }), 'a camera with a password: never in a snapshot'),
    'invalid-snapshot-bad-camsid': invalid('snapshot', withCamera({ camsId: 'Cam 1' }), 'camsId must match ' + CAMS_ID_PATTERN),
    'invalid-snapshot-unsigned': invalid('snapshot', two, 'no sig'),
    'invalid-tokens-request-upper-hex': invalid('tokens-request', { ...tokensReq, hash: 'sha256:' + 'A'.repeat(64) }, 'the hash is lower-case hex'),
    'invalid-report-value-in-items': invalid('report-request', longItems, 'a shadow item over 200 characters (a value, not a name)'),
    'valid-fleet-response': valid('fleet-response', fleet(), "one account's fleet: only that account, never a token, key or fingerprint"),
    'invalid-fleet-fingerprint': invalid('fleet-response', { ...fleet(), proxies: fleet().proxies.map((p) => ({ ...p, caFingerprints: ['SHA256:' + 'A1'.repeat(32)] })) }, 'a proxy with its CA fingerprints: never in a fleet answer'),
    'invalid-fleet-other-accounts': invalid('fleet-response', { ...fleet(), viewers: fleet().viewers.map((v) => ({ ...v, accounts: [IDS.beta] })) }, 'a viewer naming the accounts it serves: never in a fleet answer'),
    'drift-fleet-new-field': drift('fleet-response', { ...fleet(), newThing: 1 }, 'run time ignores an unknown field; strict refuses: add it to the contract first'),
    'drift-snapshot-new-field': drift('snapshot', withCamera({ newThing: 1 }), 'run time ignores an unknown field; strict refuses: add it to the contract first'),
    'drift-snapshot-no-viewer-tokens': drift('snapshot', withAccount((a) => { delete a.viewerTokens; }), 'a snapshot from before format 4: run time reads it as no viewer tokens; strict refuses'),
    'invalid-snapshot-viewer-token-secret': invalid('snapshot', withAccount((a) => { (a.viewerTokens as Record<string, unknown>[])[0].token = VIEWER_TOKEN_VECTOR; }), 'a viewer token with the token itself: never in a snapshot (only its fingerprint)'),
    'invalid-snapshot-viewer-token-fingerprint': invalid('snapshot', withAccount((a) => { (a.viewerTokens as Record<string, unknown>[])[0].fingerprint = 'sha256:' + 'A'.repeat(64); }), 'the fingerprint is sha256: + 64 lower-case hex'),
  };
}

export function camsVectors(): Record<string, unknown> {
  const k = keys();
  const SERVER = privateFromB64(k.server.privateKey);
  const CAMS = privateFromB64(k.cams.privateKey);
  const code = 'CAC1-7Q2M-K9XD-4HPA-W3ZT-RN6B';
  const enrollText = signedText.camsEnroll(code, k.cams.publicKey);
  const req = (method: string, pathAndQuery: string, body: string) => {
    const text = camsRequestText(method, pathAndQuery, NOW, NONCE, Buffer.from(body, 'utf8'));
    return { method, pathAndQuery, ts: NOW, nonce: NONCE, body, bodySha256: sha256hex(body), text, sig: sign(CAMS, text) };
  };
  const snap = unsignedSnapshot('two-accounts');
  const signedSnap = { ...snap, sig: signEnvelope(SERVER, snap) };
  const res = (status: number, body: string) => {
    const text = camsResponseText(status, NONCE, Buffer.from(body, 'utf8'));
    return { status, nonce: NONCE, body, bodySha256: sha256hex(body), text, sig: sign(SERVER, text) };
  };
  return {
    $comment: 'Fixed Ed25519 test keys (PKCS#8 = 302e020100300506032b657004220420 + seed): server = the v1 server key, cams = a cams instance, other = a stranger. Test keys only.',
    keys: k,
    enroll: [{ code, publicKey: k.cams.publicKey, text: enrollText, sig: sign(CAMS, enrollText) }],
    requests: [
      req('GET', '/cams/v1/config', ''),
      req('POST', '/cams/v1/tokens', JSON.stringify({ v: 1, proxyId: IDS.pi, kind: 'client', hash: 'sha256:' + '0'.repeat(63) + '1' })),
      req('POST', '/cams/v1/report', JSON.stringify(report('cams-admin'))),
      req('GET', `/cams/v1/accounts/${IDS.home}/fleet`, ''),
    ],
    responses: [
      res(200, JSON.stringify(signedSnap)),
      res(304, ''),
      res(401, JSON.stringify({ error: 'clock_skew', serverTime: NOW })),
    ],
    snapshots: [{ snapshot: snap, text: jcs(snap), sig: signedSnap.sig }],
    // Viewer tokens: fingerprint = "sha256:" + hex(SHA-256("cams-viewer-token v1\n" + token)); the link carries the token in the fragment only.
    viewerTokens: [{ token: VIEWER_TOKEN_VECTOR, fingerprint: viewerFingerprint(VIEWER_TOKEN_VECTOR), link: viewerLink(DEFAULT_VIEWER_LINK_URL, VIEWER_TOKEN_VECTOR) }],
  };
}
