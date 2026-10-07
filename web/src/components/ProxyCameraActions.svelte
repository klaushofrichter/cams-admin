<script lang="ts">
  // P3 (R3-18): the remote camera actions, camera renames and the proxy
  // restart the proxy allows. Disruptive ones are grouped and need the
  // action's name typed back. cams-admin never talks to a camera: the proxy
  // runs the action and re-reads what it wrote.
  import { api, errorText } from '../lib/api';
  import { EFFECT, stateLine, waitCommand } from '../lib/config';
  import Confirm from './Confirm.svelte';

  let { accountId, proxyId, refresh, camera = undefined }: { accountId: string; proxyId: string; refresh: number; camera?: string } = $props();
  const base = $derived(`/accounts/${accountId}/proxies/${proxyId}`);
  // Inventory needs a kind cams-admin doesn't know: started on the proxy itself.
  const HIDDEN = ['inventory', 'inventory-cancel', 'retention-run'];

  let av = $state<{ actions: { action: string; disruptive: boolean; allowed: boolean }[]; rename: boolean; restart: boolean; cameras: string[] } | null>(null);
  let results = $state<Record<string, string>>({});
  let busy = $state<Record<string, boolean>>({});
  let names = $state<Record<string, string>>({});
  let confirm = $state<{ action: string; camera: string | null } | null>(null);
  let error = $state('');

  async function load() {
    try { av = await api('GET', `${base}/actions`); } catch (e) { error = errorText(e); }
  }
  $effect(() => { void refresh; load(); });
  $effect(() => {
    if (camera && av) document.querySelector(`[data-testid="actions-camera-${CSS.escape(camera)}"]`)?.scrollIntoView({ block: 'center' });
  });

  const plain = $derived((av?.actions ?? []).filter((a) => !a.disruptive && !HIDDEN.includes(a.action)));
  const disruptive = $derived((av?.actions ?? []).filter((a) => a.disruptive));
  const retention = $derived((av?.actions ?? []).find((a) => a.action === 'retention-run'));

  function describe(row: any): string {
    const r = row.result ?? {};
    const parts = [`${row.args?.action ?? row.command}: ${row.state === 'done' ? 'done' : stateLine(row)}`];
    if (row.command === 'camera.name.set' && row.state === 'done') parts.push(`name "${r.name}"${r.verified ? ' (verified ✓)' : ' (not verified)'}`);
    if (r.verified === true && row.command === 'camera.action') parts.push('verified ✓');
    if (Array.isArray(r.mismatch) && r.mismatch.length) parts.push(`mismatch: ${r.mismatch.join(', ')}`);
    if (typeof r.httpStatus === 'number' && row.state === 'done') parts.push(`HTTP ${r.httpStatus}`);
    return parts.join(' · ');
  }

  async function run(key: string, send: () => Promise<{ commandId: string }>) {
    error = '';
    busy = { ...busy, [key]: true };
    results = { ...results, [key]: 'sent, waiting for the proxy' };
    try {
      const r = await send();
      const done = await waitCommand(() => api('GET', `${base}/commands/${r.commandId}`));
      results = { ...results, [key]: done ? describe(done) : 'no answer from the proxy yet' };
    } catch (e) {
      results = { ...results, [key]: errorText(e) };
    } finally {
      busy = { ...busy, [key]: false };
    }
  }
  const action = (cam: string | null, a: string, confirmText?: string) =>
    run(cam ?? 'proxy', () => api('POST', `${base}/actions`, { camera: cam, action: a, ...(confirmText ? { confirm: confirmText } : {}) }));
  const rename = (cam: string) => run(cam, () => api('POST', `${base}/cameras/${encodeURIComponent(cam)}/name`, { name: names[cam] ?? '' }));
  const restartProxy = () => run('proxy', () => api('POST', `${base}/restart`, { confirm: 'proxy.restart' }));

  function confirmed() {
    const c = confirm;
    confirm = null;
    if (!c) return;
    if (c.action === 'proxy.restart') restartProxy();
    else action(c.camera, c.action, c.action);
  }
</script>

<section class="card grid" data-testid="camera-actions">
  <h3>Camera actions</h3>
  {#if error}<p class="error">{error}</p>{/if}
  {#if !av}
    <p class="muted">Loading…</p>
  {:else}
    <p class="muted small">Each action is allowed on the proxy itself (off by default). Disruptive ones ask for their name.</p>
    {#each av.cameras as cam (cam)}
      <div class="cam grid" class:focus={camera === cam} data-testid="actions-camera-{cam}">
        <div class="row"><b class="mono">{cam}</b></div>
        <div class="row wrap">
          {#each plain as a (a.action)}
            <button class="btn" data-testid="action-{cam}-{a.action}" disabled={!a.allowed || busy[cam]} title={a.allowed ? '' : 'not allowed on the proxy'} onclick={() => action(cam, a.action)}>{a.action}</button>
          {/each}
        </div>
        <div class="row wrap">
          <span class="muted small">Disruptive:</span>
          {#each disruptive as a (a.action)}
            <button class="btn danger" data-testid="action-{cam}-{a.action}" disabled={!a.allowed || busy[cam]} title={a.allowed ? '' : 'not allowed on the proxy'} onclick={() => (confirm = { action: a.action, camera: cam })}>{a.action}</button>
          {/each}
        </div>
        <div class="row">
          <input data-testid="rename-{cam}" placeholder="new name" maxlength="64" bind:value={names[cam]} disabled={!av.rename} />
          <button class="btn" data-testid="rename-save-{cam}" disabled={!av.rename || !names[cam] || busy[cam]} title={av.rename ? '' : 'not allowed on the proxy'} onclick={() => rename(cam)}>Rename</button>
        </div>
        {#if results[cam]}<p class="mono small" data-testid="action-result-{cam}">{results[cam]}</p>{/if}
      </div>
    {:else}
      <p class="muted">The proxy reports no cameras.</p>
    {/each}
    <div class="row wrap">
      <b>Proxy</b>
      {#if retention}<button class="btn" data-testid="action-proxy-retention-run" disabled={!retention.allowed || busy.proxy} title={retention.allowed ? 'always a dry run' : 'not allowed on the proxy'} onclick={() => action(null, 'retention-run')}>retention-run (dry run)</button>{/if}
      <button class="btn danger" data-testid="restart-proxy" disabled={!av.restart || busy.proxy} title={av.restart ? '' : 'not allowed on the proxy'} onclick={() => (confirm = { action: 'proxy.restart', camera: null })}>Restart proxy</button>
    </div>
    {#if results.proxy}<p class="mono small" data-testid="action-result-proxy">{results.proxy}</p>{/if}
  {/if}
</section>

{#if confirm}
  <Confirm title={confirm.camera ? `${confirm.action} on ${confirm.camera}` : 'Restart the proxy'} body={EFFECT[confirm.action] ?? ''} typed={confirm.action} ok="Run" onconfirm={confirmed} oncancel={() => (confirm = null)} />
{/if}

<style>
  h3 { margin: 0; }
  .cam { border-top: 1px solid var(--border); padding-top: 6px; gap: 6px; }
  .cam.focus { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: 4px; }
  .wrap { flex-wrap: wrap; gap: 6px; }
  .small { font-size: 12px; margin: 0; }
</style>
