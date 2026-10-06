import type { Connection } from '../channel/connection';

// Contract P2: a command lives 60 s from its ts.
export const EXP_MS = 60_000;

// Sends one signed command on this live connection; the envelope id, or null when it can't.
export function sendCommand(c: Connection, row: { id: string; actor: string; command: string; args: Record<string, unknown>; proxyId: string }): string | null {
  return c.sendSigned('command', (now, connId) => ({
    proxyId: row.proxyId, connId, cmdId: row.id, exp: now + EXP_MS, actor: row.actor.slice(0, 200), command: row.command, args: row.args,
  }));
}
