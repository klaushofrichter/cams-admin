// A command's states, in one place. Open: still waiting for the proxy; every other state is final
// (`unknown`: the proxy never answered).

export const OPEN_STATES = ['queued', 'sent', 'received'] as const;
export const COMMAND_STATES = [...OPEN_STATES, 'done', 'refused', 'failed', 'expired', 'unknown'] as const;
export type CommandState = (typeof COMMAND_STATES)[number];

// The open states as an SQL list. Keep this exact text: SQLite matches the commands_open
// partial index (migrations.ts) on it.
export const OPEN_SQL = `('queued','sent','received')`;

export const isOpen = (state: string): boolean => (OPEN_STATES as readonly string[]).includes(state);
