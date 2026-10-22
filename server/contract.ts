import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import envelope from '../contract/v1/envelope.schema.json';
import hello from '../contract/v1/hello.schema.json';
import heartbeat from '../contract/v1/heartbeat.schema.json';
import errorSchema from '../contract/v1/error.schema.json';
import bye from '../contract/v1/bye.schema.json';
import resultSchema from '../contract/v1/result.schema.json';
import eventSchema from '../contract/v1/event.schema.json';
import tokensApplyArgsStrict from '../contract/v1/strict/commands/tokens.apply.args.schema.json';
import tokensApplyResult from '../contract/v1/commands/tokens.apply.result.schema.json';
import configGetArgs from '../contract/v1/strict/commands/config.get.args.schema.json';
import configSetArgs from '../contract/v1/strict/commands/config.set.args.schema.json';
import configUnsetArgs from '../contract/v1/strict/commands/config.unset.args.schema.json';
import configRollbackArgs from '../contract/v1/strict/commands/config.rollback.args.schema.json';
import cameraActionArgs from '../contract/v1/strict/commands/camera.action.args.schema.json';
import cameraNameSetArgs from '../contract/v1/strict/commands/camera.name.set.args.schema.json';
import proxyRestartArgs from '../contract/v1/strict/commands/proxy.restart.args.schema.json';
import configGetResult from '../contract/v1/commands/config.get.result.schema.json';
import configSetResult from '../contract/v1/commands/config.set.result.schema.json';
import configUnsetResult from '../contract/v1/commands/config.unset.result.schema.json';
import configRollbackResult from '../contract/v1/commands/config.rollback.result.schema.json';
import cameraActionResult from '../contract/v1/commands/camera.action.result.schema.json';
import cameraNameSetResult from '../contract/v1/commands/camera.name.set.result.schema.json';
import proxyRestartResult from '../contract/v1/commands/proxy.restart.result.schema.json';
import moveTargetsArgsStrict from '../contract/v1/strict/commands/move.targets.args.schema.json';
import moveTargetsResult from '../contract/v1/commands/move.targets.result.schema.json';
import moveOpenArgsStrict from '../contract/v1/strict/commands/move.open.args.schema.json';
import moveOpenResult from '../contract/v1/commands/move.open.result.schema.json';
import moveOfferArgsStrict from '../contract/v1/strict/commands/move.offer.args.schema.json';
import moveOfferResult from '../contract/v1/commands/move.offer.result.schema.json';
import moveAnswerArgsStrict from '../contract/v1/strict/commands/move.answer.args.schema.json';
import moveAnswerResult from '../contract/v1/commands/move.answer.result.schema.json';
import moveStartArgsStrict from '../contract/v1/strict/commands/move.start.args.schema.json';
import moveStartResult from '../contract/v1/commands/move.start.result.schema.json';
import moveGoArgsStrict from '../contract/v1/strict/commands/move.go.args.schema.json';
import moveGoResult from '../contract/v1/commands/move.go.result.schema.json';
import moveReleaseArgsStrict from '../contract/v1/strict/commands/move.release.args.schema.json';
import moveReleaseResult from '../contract/v1/commands/move.release.result.schema.json';
import moveFinishArgsStrict from '../contract/v1/strict/commands/move.finish.args.schema.json';
import moveFinishResult from '../contract/v1/commands/move.finish.result.schema.json';
import moveCancelArgsStrict from '../contract/v1/strict/commands/move.cancel.args.schema.json';
import moveCancelResult from '../contract/v1/commands/move.cancel.result.schema.json';
import eventStrict from '../contract/v1/strict/event.schema.json';
import { jcs } from './crypto/jcs';
import enrollRequest from '../contract/v1/enroll-request.schema.json';
import camsEnrollRequest from '../contract/cams-v1/enroll-request.schema.json';
import camsEnrollResponse from '../contract/cams-v1/enroll-response.schema.json';
import camsSnapshot from '../contract/cams-v1/snapshot.schema.json';
import camsTokensRequest from '../contract/cams-v1/tokens-request.schema.json';
import camsTokensResponse from '../contract/cams-v1/tokens-response.schema.json';
import camsRetireRequest from '../contract/cams-v1/retire-request.schema.json';
import camsRetireResponse from '../contract/cams-v1/retire-response.schema.json';
import camsReportRequest from '../contract/cams-v1/report-request.schema.json';
import camsReportResponse from '../contract/cams-v1/report-response.schema.json';
import camsError from '../contract/cams-v1/error.schema.json';
import summarySchema from '../contract/v1/health-summary.schema.json';
import truncatedSchema from '../contract/v1/health-summary-truncated.schema.json';

// Run-time validation of the proxy protocol against the lenient v1 schemas
// (contract/v1). The strict copies are for the tests of both repos.

// What a proxy may send (the server answers anything else with unsupported_type).
export const INBOUND_TYPES = ['hello', 'heartbeat', 'error', 'bye', 'result', 'event'] as const;
export type MessageType = (typeof INBOUND_TYPES)[number];
export interface Envelope { v: 1; type: MessageType; id: string; seq: number; ts: number; re?: string; body: Record<string, unknown>; sig?: string }

const ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: false });
const compile = (s: object): ValidateFunction => ajv.compile(s);
const vEnvelope = compile(envelope);
const vType: Record<MessageType, ValidateFunction> = {
  hello: compile(hello), heartbeat: compile(heartbeat), error: compile(errorSchema), bye: compile(bye),
  result: compile(resultSchema), event: compile(eventSchema),
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
  if (!(INBOUND_TYPES as readonly string[]).includes(e.type)) return { ok: false, code: 'unsupported_type', detail: e.type, type: e.type, id: e.id };
  const vt = vType[e.type];
  if (!vt(m)) return { ok: false, code: 'bad_message', detail: `${e.type}: ${errText(vt)}` };
  return { ok: true, msg: e };
}

// What cams-admin itself sends is checked strictly (a bug here is ours): the
// command's strict args schema, then what JSON Schema can't say.
const vArgs: Record<string, ValidateFunction> = {
  'tokens.apply': compile(tokensApplyArgsStrict),
  'config.get': compile(configGetArgs), 'config.set': compile(configSetArgs), 'config.unset': compile(configUnsetArgs),
  'config.rollback': compile(configRollbackArgs), 'camera.action': compile(cameraActionArgs), 'camera.name.set': compile(cameraNameSetArgs),
  'proxy.restart': compile(proxyRestartArgs),
  'move.targets': compile(moveTargetsArgsStrict), 'move.open': compile(moveOpenArgsStrict), 'move.offer': compile(moveOfferArgsStrict), 'move.answer': compile(moveAnswerArgsStrict), 'move.start': compile(moveStartArgsStrict), 'move.go': compile(moveGoArgsStrict), 'move.release': compile(moveReleaseArgsStrict), 'move.finish': compile(moveFinishArgsStrict), 'move.cancel': compile(moveCancelArgsStrict),
};
// A proxy's result payload, leniently (unknown fields ignored).
const vResult: Record<string, ValidateFunction> = {
  'tokens.apply': compile(tokensApplyResult),
  'config.get': compile(configGetResult), 'config.set': compile(configSetResult), 'config.unset': compile(configUnsetResult),
  'config.rollback': compile(configRollbackResult), 'camera.action': compile(cameraActionResult), 'camera.name.set': compile(cameraNameSetResult),
  'proxy.restart': compile(proxyRestartResult),
  'move.targets': compile(moveTargetsResult), 'move.open': compile(moveOpenResult), 'move.offer': compile(moveOfferResult), 'move.answer': compile(moveAnswerResult), 'move.start': compile(moveStartResult), 'move.go': compile(moveGoResult), 'move.release': compile(moveReleaseResult), 'move.finish': compile(moveFinishResult), 'move.cancel': compile(moveCancelResult),
};
export function validateCommandArgs(command: string, args: unknown): { ok: true } | { ok: false; detail: string } {
  const v = Object.hasOwn(vArgs, command) ? vArgs[command] : undefined;
  if (!v) return { ok: false, detail: `no args schema for ${command}` };
  if (!v(args)) return { ok: false, detail: errText(v) };
  if (command === 'tokens.apply') {
    // Uniqueness inside tokens can't be said in JSON Schema: checked here (and on the proxy).
    const t = (args as { tokens: { id: string; hash: string }[] }).tokens;
    if (new Set(t.map((x) => x.id)).size !== t.length || new Set(t.map((x) => x.hash)).size !== t.length) return { ok: false, detail: 'duplicate id or hash' };
  }
  if (Buffer.byteLength(jcs(args)) > 16384) return { ok: false, detail: 'args over 16 KiB' };
  return { ok: true };
}
export function validateResultPayload(command: string, result: unknown): boolean {
  const v = Object.hasOwn(vResult, command) ? vResult[command] : undefined;
  return v ? v(result) : isRecord(result);
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

// --- cams-v1 (the cams service API), lenient, at run time ---------------------
export const CAMS_SCHEMAS = ['enroll-request', 'enroll-response', 'snapshot', 'tokens-request', 'tokens-response', 'retire-request', 'retire-response', 'report-request', 'report-response', 'error'] as const;
export type CamsSchema = (typeof CAMS_SCHEMAS)[number];
const vCams: Record<CamsSchema, ValidateFunction> = {
  'enroll-request': compile(camsEnrollRequest), 'enroll-response': compile(camsEnrollResponse), snapshot: compile(camsSnapshot),
  'tokens-request': compile(camsTokensRequest), 'tokens-response': compile(camsTokensResponse), 'retire-request': compile(camsRetireRequest),
  'retire-response': compile(camsRetireResponse), 'report-request': compile(camsReportRequest), 'report-response': compile(camsReportResponse), error: compile(camsError),
};
export function validateCams(name: CamsSchema, value: unknown): { ok: true } | { ok: false; detail: string } {
  const v = vCams[name];
  if (!v) return { ok: false, detail: `no schema ${name}` };
  return v(value) ? { ok: true } : { ok: false, detail: errText(v).slice(0, TEXT_MAX) };
}

// --- camera-move events (proxy -> cams-admin, no cmdId) ---------------------------
// The strict event schema (closed objects, `code` on a failed phase); a body that
// passes the lenient anyOf at run time but not this is refused and audited.
const vMoveEvent = compile(eventStrict.properties.body);
export function validateMoveEvent(body: unknown): { ok: true } | { ok: false; detail: string } {
  if (!isRecord(body) || body.cmdId !== undefined) return { ok: false, detail: 'not a move event' };
  return vMoveEvent(body) ? { ok: true } : { ok: false, detail: errText(vMoveEvent).slice(0, TEXT_MAX) };
}
