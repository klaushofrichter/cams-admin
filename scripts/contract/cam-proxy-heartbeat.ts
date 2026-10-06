// The contract cross-check (spec §15.4): cam-proxy's real buildHealth(),
// from a cam-proxy checkout, on its own test inputs (one camera like the Pi;
// four cameras with a site CA and the Archive), wrapped in a heartbeat, must
// validate against contract/v1/strict/heartbeat.schema.json. A summary field
// cam-proxy added without the contract fails here.
//   tsx scripts/contract/cam-proxy-heartbeat.ts <cam-proxy checkout>
import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import Ajv2020 from 'ajv/dist/2020';
import { makeProxyInfo } from '../../test-client/summaries';

const root = resolve(process.argv[2] ?? '');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildHealth } = require(join(root, 'src/health/summary.ts'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { input, NOW } = require(join(root, 'test/helpers/health-input.ts'));

const strict = join(__dirname, '../../contract/v1/strict');
const ajv = new Ajv2020({ strict: true, allErrors: true });
for (const f of readdirSync(strict)) ajv.addSchema(JSON.parse(readFileSync(join(strict, f), 'utf8')));
const HB = 'https://cams-admin.skylar.technology/contract/v1/strict/heartbeat.schema.json';

const one = input();
const other = (i: number) => ({ camera: { ...one.camera, id: `cam${i}`, name: `Camera ${i}`, host: `192.0.2.${10 + i}:80` }, stream: one.stream, intake: one.intake, ftp: one.ftp });
const certState = { mode: 'site-ca', servername: 'cam1.garage.internal', fingerprint: 'SHA256:' + 'AB'.repeat(32), notAfter: NOW + 300 * 86400_000, lastPush: { at: NOW - 3600_000, outcome: 'current' }, problem: null };
const cases: Record<string, unknown> = {
  'one camera (the Pi)': buildHealth(one),
  'four cameras, site CA, Archive': buildHealth(input({
    others: [2, 3, 4].map(other),
    certificates: { proxy: { notAfter: NOW + 400 * 86400_000 }, cameras: [1, 2, 3, 4].map((i) => ({ id: `cam${i}`, state: certState })), problems: [] },
    archive: { count: 12, bytes: 3e9, percentOfDisk: 1.2, warning: false },
  })),
};
let failed = 0;
for (const [name, summary] of Object.entries(cases)) {
  const msg = { v: 1, type: 'heartbeat', id: '01K6' + '0'.repeat(22), seq: 2, ts: NOW, body: { summary, proxy: makeProxyInfo({ now: NOW, site: 'garage' }), truncated: false } };
  if (ajv.validate(HB, msg)) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`DRIFT ${name}:`);
    for (const e of ajv.errors ?? []) console.log(`      ${e.instancePath || '/'} ${e.message}${e.params && 'additionalProperty' in e.params ? `: ${(e.params as { additionalProperty: string }).additionalProperty}` : ''}`);
  }
}
process.exit(failed ? 1 : 0);
