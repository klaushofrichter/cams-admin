import { appendFileSync, chmodSync, existsSync, readFileSync } from 'fs';
import type { Logger } from '../log';

// Security review 2026-10-07 (M5): what was revoked for cams instances is
// also written to a journal next to the database (one JSON line each, mode
// 600), outside the database and so outside its backups. buildServer replays
// it at every start: a restore from an older backup can't bring back a
// blocked instance, a revoked cams key or a revoked cams-held token. Every
// entry names exact ids, so a replay never touches anything newer.
export type Revocation =
  | { at: number; kind: 'block'; instanceId: string }
  | { at: number; kind: 'key'; instanceId: string; keyId: string }
  | { at: number; kind: 'tokens'; tokenIds: string[] };
export type RevocationEntry = Revocation extends infer R ? (R extends Revocation ? Omit<R, 'at'> : never) : never;

export class RevocationJournal {
  constructor(private file: string, private log?: Logger) {}

  append(r: RevocationEntry, at: number): void {
    appendFileSync(this.file, JSON.stringify({ at, ...r }) + '\n', { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }

  read(): Revocation[] {
    if (!existsSync(this.file)) return [];
    const out: Revocation[] = [];
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Revocation);
      } catch {
        this.log?.warn('cams_revocation_line_unreadable');
      }
    }
    return out;
  }
}
