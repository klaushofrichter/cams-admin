import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import envelope from '../contract/v1/envelope.schema.json';
import challenge from '../contract/v1/challenge.schema.json';
import hello from '../contract/v1/hello.schema.json';
import welcome from '../contract/v1/welcome.schema.json';
import heartbeat from '../contract/v1/heartbeat.schema.json';
import ack from '../contract/v1/ack.schema.json';
import errorSchema from '../contract/v1/error.schema.json';
import bye from '../contract/v1/bye.schema.json';
import enrollRequest from '../contract/v1/enroll-request.schema.json';
import summarySchema from '../contract/v1/health-summary.schema.json';
import truncatedSchema from '../contract/v1/health-summary-truncated.schema.json';

// Run-time validation of the proxy protocol against the lenient v1 schemas
// (contract/v1). The strict copies are for the tests of both repos.

export const MESSAGE_TYPES = ['challenge', 'hello', 'welcome', 'heartbeat', 'ack', 'error', 'bye'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];
export interface Envelope { v: 1; type: MessageType; id: string; seq: number; ts: number; re?: string; body: Record<string, unknown>; sig?: string }

const ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: false });
const compile = (s: object): ValidateFunction => ajv.compile(s);
const vEnvelope = compile(envelope);
const vType: Record<MessageType, ValidateFunction> = {
  challenge: compile(challenge), hello: compile(hello), welcome: compile(welcome), heartbeat: compile(heartbeat),
  ack: compile(ack), error: compile(errorSchema), bye: compile(bye),
};
const vEnroll = compile(enrollRequest);
const vSummary = compile(summarySchema);
const vTruncated = compile(truncatedSchema);

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

// v must be 1: another integer is a version this server doesn't speak, anything else is malformed.
function badVersion<C extends string>(x: Record<string, unknown>, malformed: C): { ok: false; code: C | 'unsupported_version'; detail: string } | null {
  if (x.v === 1) return null;
  return Number.isInteger(x.v) ? { ok: false, code: 'unsupported_version', detail: `v ${x.v}` } : { ok: false, code: malformed, detail: 'v missing' };
}

const errText = (v: ValidateFunction) => (v.errors?.[0] ? `${v.errors[0].instancePath || '/'} ${v.errors[0].message}` : 'invalid');

export type MessageVerdict = { ok: true; msg: Envelope } | { ok: false; code: 'bad_message' | 'unsupported_version' | 'unsupported_type'; detail: string; type?: string; id?: string };

export function validateMessage(m: unknown): MessageVerdict {
  if (!isRecord(m)) return { ok: false, code: 'bad_message', detail: 'not an object' };
  const bad = badVersion(m, 'bad_message');
  if (bad) return bad;
  if (!vEnvelope(m)) return { ok: false, code: 'bad_message', detail: errText(vEnvelope) };
  const e = m as unknown as Envelope;
  if (!(MESSAGE_TYPES as readonly string[]).includes(e.type)) return { ok: false, code: 'unsupported_type', detail: e.type, type: e.type, id: e.id };
  const vt = vType[e.type];
  if (!vt(m)) return { ok: false, code: 'bad_message', detail: `${e.type}: ${errText(vt)}` };
  return { ok: true, msg: e };
}

export type EnrollVerdict = { ok: true } | { ok: false; code: 'bad_request' | 'unsupported_version'; detail: string };
export function validateEnroll(b: unknown): EnrollVerdict {
  if (!isRecord(b)) return { ok: false, code: 'bad_request', detail: 'not an object' };
  return badVersion(b, 'bad_request') ?? (vEnroll(b) ? { ok: true } : { ok: false, code: 'bad_request', detail: errText(vEnroll) });
}

export const TEXT_MAX = 200;
const MAX_DEPTH = 8;

// A copy with every string clamped to 200 characters and anything deeper
// than 8 levels replaced by "…": what is stored and shown is bounded, whatever
// a proxy sends in fields this version doesn't know.
export function sanitize(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.length > TEXT_MAX ? v.slice(0, TEXT_MAX) : v;
  if (v === null || typeof v !== 'object') return v;
  if (depth >= MAX_DEPTH) return '…';
  if (Array.isArray(v)) return v.map((x) => sanitize(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    // defineProperty: a "__proto__" key from the wire stays a plain own
    // property and never becomes the object's prototype.
    Object.defineProperty(out, k.length > 64 ? k.slice(0, 64) : k, { value: sanitize(x, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

export type SummaryVerdict = { ok: true; summary: Record<string, unknown> } | { ok: false; reason: string };
export function validateSummary(s: unknown, truncated: boolean): SummaryVerdict {
  if (!isRecord(s)) return { ok: false, reason: 'not an object' };
  const schema = s.schema;
  if (schema !== 1) return { ok: false, reason: `unreadable summary (schema ${typeof schema === 'number' ? schema : '?'})` };
  const clean = sanitize(s) as Record<string, unknown>;
  const v = truncated ? vTruncated : vSummary;
  return v(clean) ? { ok: true, summary: clean } : { ok: false, reason: `unreadable summary (${errText(v)})` };
}
