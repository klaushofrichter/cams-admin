import { readFileSync, renameSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { readEpoch, type Db } from './open';

// The app mirrors meta.write_epoch into a small file next to the database.
// A database whose counter is lower than the file's went back in time: it
// was restored (spec §11.4). No file: a fresh volume.
export function checkEpoch(db: Db, file: string): 'fresh' | 'same' | 'restored' {
  let fromFile: number;
  try {
    fromFile = Number(readFileSync(file, 'utf8').trim());
  } catch {
    return 'fresh';
  }
  if (!Number.isFinite(fromFile)) return 'fresh';
  return readEpoch(db) < fromFile ? 'restored' : 'same';
}

export function writeEpochFile(db: Db, file: string): number {
  const epoch = readEpoch(db);
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, String(epoch));
  renameSync(tmp, file);
  return epoch;
}

// The tick's writer: writes the file only when the epoch moved since its last write (the
// epoch moves on real transactions only), or when forced (start, close).
export function epochFileWriter(db: Db, file: string): (force?: boolean) => void {
  let written: number | null = null;
  return (force = false) => {
    if (!force && written !== null && readEpoch(db) === written) return;
    written = writeEpochFile(db, file);
  };
}
