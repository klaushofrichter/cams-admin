// The next HH:MM in a time zone after `now` (ms, UTC), DST-safe: the wall
// time is converted with the zone's offset at that moment.
function offsetMs(at: number, tz: string): number {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(at / 1000) * 1000;
}

export function nextRunAt(now: number, hhmm: string, tz: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  const local = new Date(now + offsetMs(now, tz));
  for (let addDays = 0; addDays < 3; addDays++) {
    const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + addDays, h, m);
    // Two passes settle the offset at the target time.
    let t = wall - offsetMs(wall, tz);
    t = wall - offsetMs(t, tz);
    if (t > now) return t;
  }
  throw new Error('nextRunAt: no time found');
}
