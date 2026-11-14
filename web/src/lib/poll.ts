// The one wait loop of the web: ask until a condition holds, with a cap.

// Ask every 2 s until `done`, for at most 60 s; null when it never was.
export async function poll<T>(get: () => Promise<T>, done: (v: T) => boolean, o: { sleep?: (ms: number) => Promise<void>; everyMs?: number; maxMs?: number } = {}): Promise<T | null> {
  const every = o.everyMs ?? 2000;
  const max = o.maxMs ?? 60_000;
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let waited = 0; ; waited += every) {
    const v = await get();
    if (done(v)) return v;
    if (waited + every > max) return null;
    await sleep(every);
  }
}
