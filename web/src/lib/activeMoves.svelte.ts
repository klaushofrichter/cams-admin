// The moves under way, shared by the menu and the Dashboard: loaded once
// signed in, again on every move registry event (and on a reconnect).
import { api } from './api';
import { coalesced, live } from './live';
import { activeMoves } from './moves';

export const moving = $state<{ items: any[] }>({ items: [] });
let stop: (() => void) | null = null;

const load = () => api('GET', '/moves').then((x) => (moving.items = activeMoves(x.items))).catch(() => {});

export function watchMoves(): () => void {
  if (!stop) {
    load();
    const soon = coalesced(load, 500);
    stop = live({ registry: (r) => { if (r.type === 'move') soon(); }, open: soon });
  }
  return () => { stop?.(); stop = null; };
}
