import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMAND_STATES, isOpen, OPEN_SQL, OPEN_STATES } from '../server/commands/states';
import { FINAL_STATES } from '../server/moves/common';

const migrations = readFileSync(join(__dirname, '../server/db/migrations.ts'), 'utf8');

describe('command states (one list for open and final)', () => {
  it('the states are the commands table CHECK list', () => {
    const check = /state TEXT NOT NULL CHECK \(state IN \(('queued'[^)]*)\)\)/.exec(migrations);
    expect(check).not.toBeNull();
    expect(check![1].split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual([...COMMAND_STATES]);
  });
  it('OPEN_SQL is the commands_open partial index text, and lists OPEN_STATES', () => {
    expect(migrations).toContain(`CREATE INDEX commands_open ON commands(state, created_at) WHERE state IN ${OPEN_SQL};`);
    expect(OPEN_SQL).toBe(`(${OPEN_STATES.map((s) => `'${s}'`).join(',')})`);
  });
  it('open and final split the states', () => {
    for (const s of COMMAND_STATES) expect(isOpen(s)).toBe(!FINAL_STATES.has(s));
    expect([...FINAL_STATES].sort()).toEqual(['done', 'expired', 'failed', 'refused', 'unknown']);
    expect(isOpen('nonsense')).toBe(false);
  });
});
