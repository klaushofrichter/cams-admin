<script lang="ts">
  // Camera moves between two proxies of one account: every move, its phase and progress; the detail has cancel and end transfer.
  import { onMount } from 'svelte';
  import { api, errorText, ApiFailure } from '../lib/api';
  import { coalesced, live } from '../lib/live';
  import { cancelable, etaText, phaseClass, phaseReason, phaseText, presummaryErrorText, presummaryLines, presummarySpaceText, progressText, refusalLine, refusalText, startBody, cameraLabel } from '../lib/moves';
  import MoveDetail from '../components/MoveDetail.svelte';
  import FirewallLines from '../components/FirewallLines.svelte';
  import { moveFirewall } from '../lib/profile';

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
  // The target's reported profile: the firewall lines it will need for the chosen camera (run them there first).
  let targetProfile = $state<{ id: string; profile: any } | null>(null);
  $effect(() => {
    const id = targetId;
    targetProfile = null;
    if (!id) return;
    api('GET', `/proxies/${id}/profile`).then((r) => { if (targetId === id) targetProfile = { id, profile: r.profile }; }).catch(() => { if (targetId === id) targetProfile = { id, profile: null }; });
  });
  const targetName = $derived(proxies.find((p) => p.id === targetId)?.displayName ?? '');
  // The camera's content before the move (move.summary to the source, through cams-admin) and the target's free
  // budget against it. Unavailable (an older proxy, offline, no answer in time): a muted line, the form still works.
  let presummary = $state<{ key: string; loading: boolean; answer?: any; error?: string } | null>(null);
  $effect(() => {
    const acc = accountId, cam = cameraId, tgt = targetId;
    presummary = null;
    if (!acc || !cam || !tgt) return;
    const key = `${cam}|${tgt}`;
    presummary = { key, loading: true };
    api('GET', `/accounts/${acc}/cameras/${cam}/move-summary?target=${encodeURIComponent(tgt)}`)
      .then((answer) => { if (presummary?.key === key) presummary = { key, loading: false, answer }; })
      .catch((e) => { if (presummary?.key === key) presummary = { key, loading: false, error: e instanceof ApiFailure ? presummaryErrorText(e.body) : errorText(e) }; });
  });
  const firewall = $derived(targetProfile && cameraId && targetProfile.id === targetId ? moveFirewall(targetName, targetProfile.profile, cameras.find((c) => c.id === cameraId)?.host) : null);
  async function start(e: Event) {
    e.preventDefault();
    // A double click (or Enter twice) sends one request: the button stays disabled until it settles.
    if (sending) return;
    sending = true; startError = ''; startOk = '';
    try {
      const out = await api('POST', '/moves', startBody(sourceId, targetId, cameraId));
      const fixed = (out.fixed ?? []).length ? ` cams-admin fixed: ${out.fixed.map((f: any) => f.rule).join(', ')}.` : '';
      startOk = `Move requested.${fixed}`;
      await load();
    } catch (err) { startError = err instanceof ApiFailure && err.body ? refusalText(err.body) : errorText(err); }
    finally { sending = false; }
  }
  // The link between a cancelled move and its copy back: open the other one's detail and scroll to it.
  function show(id: string) {
    open[id] = true;
    setTimeout(() => document.querySelector(`[data-testid="move-row-${id}"]`)?.scrollIntoView({ block: 'center' }), 0);
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
        {#each camerasOnSource as c (c.id)}<option value={c.id}>{cameraLabel(c)}</option>{/each}
      </select>
    </label>
    <label>To proxy
      <select data-testid="start-move-target" bind:value={targetId}>
        <option value="">Choose…</option>
        {#each targets as p (p.id)}<option value={p.id}>{p.displayName}</option>{/each}
      </select>
    </label>
    <button class="btn primary" data-testid="start-move-submit" disabled={sending || !sourceId || !cameraId || !targetId} aria-busy={sending}>{sending ? 'Starting…' : 'Start move'}</button>
  </form>
  {#if presummary}
    <div class="grid presummary" data-testid="start-move-summary">
      {#if presummary.loading}
        <p class="muted small" data-testid="start-move-summary-loading">Asking the source proxy what the camera holds…</p>
      {:else if presummary.answer}
        <p class="small">What the camera holds on the source now:</p>
        <ul>
          {#each presummaryLines(presummary.answer.summary ?? {}) as l (l.kind)}<li data-testid="start-move-summary-{l.kind}">{l.text}</li>{/each}
        </ul>
        {#if presummary.answer.target}
          <p class="small" class:warn={presummary.answer.space && !presummary.answer.space.fits} data-testid="start-move-space">{presummarySpaceText({ name: targetName || presummary.answer.target.name, profile: presummary.answer.target.profile }, presummary.answer.space)}</p>
        {/if}
      {:else}
        <p class="muted small" data-testid="start-move-summary-none">Content not available: {presummary.error}. The move can start anyway.</p>
      {/if}
    </div>
  {/if}
  {#if firewall}
    <div class="grid" data-testid="start-move-firewall">
      {#if 'lines' in firewall}
        <p>Run these on {targetName} first, so the camera's FTP uploads reach it ({firewall.tool}):</p>
        <FirewallLines lines={firewall.lines} testid="start-move-firewall-box" />
      {:else}
        <p class="muted" data-testid="start-move-firewall-none">{firewall.none}</p>
      {/if}
    </div>
  {/if}
  {#if startOk}<p data-testid="start-move-ok">{startOk}</p>{/if}
  {#if startError}<p class="error" data-testid="start-move-error">{startError}</p>{/if}
</section>

<section class="card grid">
  <h2>Moves</h2>
  <p class="muted">A camera moving from one proxy to another of the same account: its phase and progress, cancel, end the transfer early, and the copy back after a cancel. A refused move says who refused it and why; delete it once you have read it.</p>
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
              <span class="chip {phaseClass(m.phase)}" data-testid="move-phase-{m.id}">{phaseText(m.phase, m.reason)}</span>
              {#if m.phase === 'rejected'}<span class="muted small" data-testid="move-reason-{m.id}"> {refusalLine(m)}</span>
              {:else if phaseReason(m.phase, m.reason) && (m.phase === 'failed' || m.phase === 'returning' || m.phase === 'returned')}<span class="muted small" data-testid="move-reason-{m.id}"> {phaseReason(m.phase, m.reason)}</span>{/if}
              {#if m.budgetExceeded}<span class="badge warn" data-testid="move-budget-{m.id}">Over time budget</span>{/if}
            </td>
            <td>{progressText(m)}{#if (m.phase === 'copying' || m.phase === 'returning') && etaText(m.etaS)}<div class="muted small">{etaText(m.etaS)}</div>{/if}</td>
          </tr>
          {#if shown(m)}
            <tr class="detail"><td colspan="5"><MoveDetail move={m} onchange={load} onopen={show} /></td></tr>
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
  .presummary p { margin: 0; }
  .presummary ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; font-size: 13px; }
  .warn { color: var(--warning); }
  .detail td { border-top: 0; padding-top: 0; }
  .link { background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; font: inherit; text-decoration: underline; }
</style>
