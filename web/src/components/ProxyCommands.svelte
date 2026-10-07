<script lang="ts">
  // The proxy's command policy (as it reports it) and cams-admin's command
  // history; P3 rows show their args and result, and a real settings write
  // can be rolled back (a dry run of the rollback first, then its Apply).
  import { api, errorText } from '../lib/api';
  import { cmdStateClass, cmdStateText, commandsText } from '../lib/commands';
  import { rollbackable, stateLine, valueText, waitCommand, type Change } from '../lib/config';
  import { when } from '../lib/format';
  import DiffTable from './DiffTable.svelte';

  let { accountId, proxyId, policy, allow, refresh }: { accountId: string; proxyId: string; policy: string; allow: string[]; refresh: number } = $props();
  let items = $state<any[]>([]);
  let next = $state<string | null>(null);
  let error = $state('');
  // A rollback in progress: the row it undoes, its dry run, then its outcome.
  let rb = $state<{ of: string; previewId?: string; changes?: Change[]; text: string; current?: Record<string, { v?: unknown; s: string }> } | null>(null);
  const base = $derived(`/accounts/${accountId}/proxies/${proxyId}`);

  async function load() {
    try {
      const r = await api('GET', `${base}/commands?limit=20`);
      items = r.items;
      next = r.nextCursor;
    } catch (e) { error = errorText(e); }
  }
  async function more() {
    try {
      const r = await api('GET', `${base}/commands?limit=20&cursor=${encodeURIComponent(next!)}`);
      items = [...items, ...r.items];
      next = r.nextCursor;
    } catch (e) { error = errorText(e); }
  }
  $effect(() => { void refresh; load(); });

  const P3 = ['config.set', 'config.unset', 'config.rollback', 'camera.action', 'camera.name.set', 'proxy.restart'];
  function argsText(c: any): string {
    const a = c.args ?? {};
    if (c.command === 'config.set') return Object.entries(a.set ?? {}).map(([p, v]) => `${p} = ${valueText(v)}`).join(', ');
    if (c.command === 'config.unset') return `reset ${(a.paths ?? []).join(', ')}`;
    if (c.command === 'config.rollback') return `undo ${a.cmdId}`;
    if (c.command === 'camera.action') return `${a.action}${a.camera ? ` on ${a.camera}` : ''}`;
    if (c.command === 'camera.name.set') return `${a.camera} → "${a.name}"`;
    return '';
  }
  const label = (c: any) => (c.dryRun ? 'dry run' : '');

  async function rollbackPreview(c: any) {
    error = '';
    rb = { of: c.id, text: 'asking the proxy for a dry run…' };
    try {
      const r = await api('POST', `${base}/config/rollback/preview`, { cmdId: c.id });
      const done = await waitCommand(() => api('GET', `${base}/commands/${r.commandId}`));
      if (done?.state === 'done') rb = { of: c.id, previewId: r.commandId, changes: done.result?.changes ?? [], text: '' };
      else if (done?.outcomeCode === 'conflict') rb = { of: c.id, text: 'changed on the proxy since: roll back is not possible for these settings', current: done.result?.current ?? {} };
      else rb = { of: c.id, text: done ? stateLine(done) : 'no answer from the proxy yet' };
    } catch (e) { rb = { of: c.id, text: errorText(e) }; }
  }
  async function rollbackApply() {
    if (!rb?.previewId) return;
    const of = rb.of;
    try {
      const r = await api('POST', `${base}/config/rollback/apply`, { previewId: rb.previewId });
      rb = { of, text: 'rolling back…' };
      const done = await waitCommand(() => api('GET', `${base}/commands/${r.commandId}`));
      rb = done?.outcomeCode === 'conflict'
        ? { of, text: 'changed on the proxy since: roll back is not possible for these settings', current: done.result?.current ?? {} }
        : { of, text: done ? (done.state === 'done' ? 'rolled back' : stateLine(done)) : 'no answer from the proxy yet' };
      await load();
    } catch (e) { rb = { of, text: errorText(e) }; }
  }
</script>

<section class="card grid" data-testid="commands">
  <h3>Commands</h3>
  <p class:muted={policy !== 'allowed'} data-testid="commands-policy">{commandsText(policy, allow)}</p>
  {#if error}<p class="error">{error}</p>{/if}
  {#if items.length}
    <div class="scroll-x">
      <table data-testid="commands-list">
        <thead><tr><th>When</th><th>By</th><th>Command</th><th>State</th><th></th></tr></thead>
        <tbody>
          {#each items as c (c.id)}
            <tr data-testid="command-{c.id}">
              <td>{when(c.createdAt)}</td><td>{c.actor}</td>
              <td class="mono">{c.command}{c.args?.revision !== undefined ? ` r${c.args.revision}` : ''}{c.attempts > 1 ? ` ×${c.attempts}` : ''}{#if label(c)} <span class="badge">{label(c)}</span>{/if}
                {#if P3.includes(c.command) && argsText(c)}<div class="muted small" data-testid="command-args-{c.id}">{argsText(c)}</div>{/if}
              </td>
              <td><span class="chip {cmdStateClass(c.state)}" data-testid="command-state-{c.id}">{P3.includes(c.command) || c.command === 'config.get' ? (c.state === 'done' ? 'done' : stateLine(c)) : cmdStateText(c.state, c.outcomeCode)}</span></td>
              <td>{#if rollbackable(c)}<button class="btn" data-testid="command-rollback-{c.id}" onclick={() => rollbackPreview(c)}>Roll back</button>{/if}</td>
            </tr>
            {#if (c.command.startsWith('config.') && c.command !== 'config.get' && c.result?.changes) || (c.command === 'camera.action' && c.result) || rb?.of === c.id}
              <tr class="detail"><td colspan="5">
                {#if c.result?.changes}<DiffTable changes={c.result.changes} unchanged={c.result.unchanged ?? []} testid="command-diff-{c.id}" />{/if}
                {#if c.command === 'camera.action' && c.result}
                  <span class="small">{c.result.verified === true ? 'verified ✓' : ''}{c.result.mismatch?.length ? ` mismatch: ${c.result.mismatch.join(', ')}` : ''} HTTP {c.result.httpStatus}</span>
                {/if}
                {#if rb && rb.of === c.id}
                  {@const r = rb}
                  <div class="grid rollback" data-testid="rollback">
                    {#if r.changes}
                      <b>Roll back: what the proxy would change</b>
                      <DiffTable changes={r.changes} testid="rollback-diff" />
                      <div class="row"><button class="btn primary" data-testid="rollback-apply" onclick={rollbackApply}>Apply rollback</button><button class="btn" onclick={() => (rb = null)}>Cancel</button></div>
                    {/if}
                    {#if r.text}<p class="muted" data-testid="rollback-status">{r.text}</p>{/if}
                    {#if r.current}
                      <table data-testid="rollback-conflict"><tbody>{#each Object.entries(r.current) as [p, v] (p)}<tr><td class="mono">{p}</td><td class="mono">on the proxy now: {valueText(v.v)} ({v.s})</td></tr>{/each}</tbody></table>
                    {/if}
                  </div>
                {/if}
              </td></tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
    {#if next}<button class="btn" data-testid="commands-more" onclick={more}>More</button>{/if}
  {:else}
    <p class="muted">No commands sent yet.</p>
  {/if}
</section>

<style>
  .small { font-size: 12px; }
  .detail td { border-top: 0; padding-top: 0; }
  .rollback { border: 1px dashed var(--accent); border-radius: 8px; padding: 8px; }
</style>
