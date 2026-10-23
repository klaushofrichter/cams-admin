<script lang="ts">
  // Camera moves between two proxies of one account: every move, its phase and progress; the detail has cancel and end transfer.
  import { onMount } from 'svelte';
  import { api, errorText, ApiFailure } from '../lib/api';
  import { coalesced, live } from '../lib/live';
  import { cancelable, etaText, phaseClass, phaseText, progressText, reasonText, refusalText, startBody } from '../lib/moves';
  import MoveDetail from '../components/MoveDetail.svelte';

  let items = $state<any[]>([]);
  let loaded = $state(false);
  let error = $state('');
  let open = $state<Record<string, boolean>>({});

  async function load() {
    try {
      items = (await api('GET', '/moves')).items;
      error = '';
    } catch (e) { error = errorText(e); }
    loaded = true;
  }
  onMount(() => {
    load();
    const soon = coalesced(load, 250);
    return live({ registry: (r) => { if (r.type === 'move') soon(); }, open: soon });
  });

  // Start move: the account's proxies and cameras feed the selects.
  let accounts = $state<any[]>([]);
  let proxies = $state<any[]>([]);
  let cameras = $state<any[]>([]);
  let accountId = $state('');
  let sourceId = $state('');
  let cameraId = $state('');
  let targetId = $state('');
  let sending = $state(false);
  let startError = $state('');
  let startOk = $state('');
  const sources = $derived(proxies);
  const camerasOnSource = $derived(cameras.filter((c) => c.proxyId === sourceId));
  const targets = $derived(proxies.filter((p) => p.id !== sourceId));
  async function loadAccount(id: string) {
    proxies = []; cameras = []; sourceId = cameraId = targetId = '';
    if (!id) return;
    try {
      const [p, c] = await Promise.all([api('GET', `/accounts/${id}/proxies`), api('GET', `/accounts/${id}/cameras`)]);
      if (id === accountId) { proxies = p.items; cameras = c.items; }
    } catch (e) { startError = errorText(e); }
  }
  onMount(async () => {
    try {
      accounts = (await api('GET', '/accounts')).items;
      if (accounts.length === 1) { accountId = accounts[0].id; await loadAccount(accountId); }
    } catch (e) { startError = errorText(e); }
  });
  $effect(() => { if (!camerasOnSource.some((c) => c.id === cameraId)) cameraId = camerasOnSource.length === 1 ? camerasOnSource[0].id : ''; });
  $effect(() => { if (!targets.some((p) => p.id === targetId)) targetId = ''; });
  async function start(e: Event) {
    e.preventDefault();
    sending = true; startError = ''; startOk = '';
    try {
      const out = await api('POST', '/moves', startBody(sourceId, targetId, cameraId));
      const fixed = (out.fixed ?? []).length ? ` cams-admin fixed: ${out.fixed.map((f: any) => f.rule).join(', ')}.` : '';
      startOk = `Move requested.${fixed}`;
      await load();
    } catch (err) { startError = err instanceof ApiFailure && err.body ? refusalText(err.body) : errorText(err); }
    sending = false;
  }
  const shown = (m: any) => open[m.id] ?? (cancelable(m.phase) || m.endedAt === null);
</script>

<section class="card grid">
  <h2>Start move</h2>
  <p class="muted">Move a camera to another proxy of the same account. It copies everything the target has room for; you can cancel it below.</p>
  <form class="row" onsubmit={start}>
    <label>Account
      <select data-testid="start-move-account" bind:value={accountId} onchange={() => loadAccount(accountId)}>
        <option value="">Choose…</option>
        {#each accounts as a (a.id)}<option value={a.id}>{a.displayName}</option>{/each}
      </select>
    </label>
    <label>From proxy
      <select data-testid="start-move-source" bind:value={sourceId}>
        <option value="">Choose…</option>
        {#each sources as p (p.id)}<option value={p.id}>{p.displayName}</option>{/each}
      </select>
    </label>
    <label>Camera
      <select data-testid="start-move-camera" bind:value={cameraId}>
        <option value="">Choose…</option>
        {#each camerasOnSource as c (c.id)}<option value={c.id}>{c.name || c.camsId}</option>{/each}
      </select>
    </label>
    <label>To proxy
      <select data-testid="start-move-target" bind:value={targetId}>
        <option value="">Choose…</option>
        {#each targets as p (p.id)}<option value={p.id}>{p.displayName}</option>{/each}
      </select>
    </label>
    <button class="btn primary" data-testid="start-move-submit" disabled={sending || !sourceId || !cameraId || !targetId}>Start move</button>
  </form>
  {#if startOk}<p data-testid="start-move-ok">{startOk}</p>{/if}
  {#if startError}<p class="error" data-testid="start-move-error">{startError}</p>{/if}
</section>

<section class="card grid">
  <h2>Moves</h2>
  <p class="muted">A camera moving from one proxy to another of the same account: its phase and progress, and cancel or end the transfer early.</p>
  {#if error}<p class="error" data-testid="moves-error">{error}</p>{/if}
  <div class="scroll-x">
    <table data-testid="moves-list">
      <thead><tr><th>Camera</th><th>From</th><th>To</th><th>Phase</th><th>Progress</th></tr></thead>
      <tbody>
        {#each items as m (m.id)}
          <tr data-testid="move-row-{m.id}">
            <td><button class="link" data-testid="move-toggle-{m.id}" onclick={() => (open[m.id] = !shown(m))}>{m.cameraName || m.camsId}</button></td>
            <td>{m.source.name}</td>
            <td>{m.target.name}</td>
            <td>
              <span class="chip {phaseClass(m.phase)}" data-testid="move-phase-{m.id}">{phaseText(m.phase)}</span>
              {#if m.reason && (m.phase === 'rejected' || m.phase === 'failed')}<span class="muted small" data-testid="move-reason-{m.id}"> {reasonText(m.reason)}</span>{/if}
              {#if m.budgetExceeded}<span class="badge warn" data-testid="move-budget-{m.id}">Over time budget</span>{/if}
            </td>
            <td>{progressText(m)}{#if m.phase === 'copying' && etaText(m.etaS)}<div class="muted small">{etaText(m.etaS)}</div>{/if}</td>
          </tr>
          {#if shown(m)}
            <tr class="detail"><td colspan="5"><MoveDetail move={m} onchange={load} /></td></tr>
          {/if}
        {/each}
        {#if loaded && !items.length}<tr><td colspan="5" class="muted" data-testid="moves-empty">No camera move yet. Start one with the Start move form above, or ask for a move in cams.</td></tr>{/if}
      </tbody>
    </table>
  </div>
</section>

<style>
  h2 { margin: 0; }
  form { align-items: end; }
  .small { font-size: 12px; }
  .detail td { border-top: 0; padding-top: 0; }
  .link { background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; font: inherit; text-decoration: underline; }
</style>
