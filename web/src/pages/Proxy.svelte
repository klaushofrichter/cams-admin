<script lang="ts">
  import { onMount } from 'svelte';
  import { api, errorText } from '../lib/api';
  import { coalesced, live } from '../lib/live';
  import { camClass, keyState, when } from '../lib/format';
  import { summaryLeaves } from '../lib/summaryTree';
  import StateChip from '../components/StateChip.svelte';
  import Ago from '../components/Ago.svelte';
  import Confirm from '../components/Confirm.svelte';

  let { accountId, proxyId }: { accountId: string; proxyId: string } = $props();

  let d = $state<any>(null);
  let events = $state<any[]>([]);
  let error = $state('');
  let gone = $state(false);
  let shownCode = $state<{ id: string; code: string; command: string; expiresAt: number } | null>(null);
  let lifetimeH = $state(24);
  let confirm = $state<null | { kind: 'revoke' | 'block' | 'delete'; keyId?: string }>(null);
  let showAll = $state(false);

  async function load() {
    try {
      d = await api('GET', `/accounts/${accountId}/proxies/${proxyId}/status`);
      events = (await api('GET', `/accounts/${accountId}/proxies/${proxyId}/status-events?limit=30`)).items;
    } catch (e: any) {
      if (e?.status === 404) gone = true;
      else error = errorText(e);
    }
  }
  onMount(() => {
    load();
    const soon = coalesced(load, 250);
    return live({ status: (s) => { if (s.proxyId === proxyId) soon(); }, registry: soon, open: soon });
  });

  // --- registry fields --------------------------------------------------------------------------
  let f = $state<any>({});
  $effect(() => {
    if (d && f.id !== d.proxy.id + d.proxy.version) {
      const p = d.proxy;
      f = { id: p.id + p.version, displayName: p.displayName, runsOn: p.runsOn, hostKind: p.hostKind ?? '', url: p.url ?? '', adminUiUrl: p.adminUiUrl ?? '', dnsName: p.dnsName ?? '', tlsSite: p.tlsSite ?? '', tlsServername: p.tlsServername ?? '', fps: p.caFingerprints.join('\n'), notes: p.notes ?? '' };
    }
  });
  async function save() {
    error = '';
    try {
      await api('PATCH', `/accounts/${accountId}/proxies/${proxyId}`, {
        displayName: f.displayName, runsOn: f.runsOn, hostKind: f.hostKind || null, url: f.url || null, adminUiUrl: f.adminUiUrl || null, dnsName: f.dnsName || null,
        tlsSite: f.tlsSite || null, tlsServername: f.tlsServername || null, caFingerprints: f.fps.split(/[\s,]+/).filter(Boolean), notes: f.notes || null, version: d.proxy.version,
      });
      await load();
    } catch (e) { error = errorText(e); }
  }

  // --- enrollment and keys ----------------------------------------------------------------------
  async function createCode() {
    error = '';
    try {
      const c = await api('POST', `/accounts/${accountId}/proxies/${proxyId}/enrollment-codes`, { lifetimeH: Number(lifetimeH) });
      await load(); // first: the page then knows the code is live
      shownCode = c;
    } catch (e) { error = errorText(e); }
  }
  // The shown code was redeemed (or replaced, cancelled, expired): gone with it.
  $effect(() => {
    if (shownCode && d && d.enrollment?.id !== shownCode.id) shownCode = null;
  });
  async function cancelCode() {
    try { await api('DELETE', `/accounts/${accountId}/proxies/${proxyId}/enrollment-codes/${d.enrollment.id}`); shownCode = null; await load(); } catch (e) { error = errorText(e); }
  }
  async function act() {
    const c = confirm;
    confirm = null;
    try {
      if (c?.kind === 'revoke') await api('POST', `/accounts/${accountId}/proxies/${proxyId}/keys/${c.keyId}/revoke`, {});
      if (c?.kind === 'block') await api('POST', `/accounts/${accountId}/proxies/${proxyId}/block`, {});
      if (c?.kind === 'delete') { await api('DELETE', `/accounts/${accountId}/proxies/${proxyId}`); location.hash = `#/accounts/${accountId}/proxies`; return; }
      await load();
    } catch (e) { error = errorText(e); }
  }
  async function adopt(ref: string, camsId: string) {
    try { await api('POST', `/accounts/${accountId}/proxies/${proxyId}/adopt`, { proxyCameraId: ref, camsId, kind: 'camera' }); await load(); } catch (e) { error = errorText(e); }
  }
  const copy = (t: string) => navigator.clipboard?.writeText(t);

  const s = $derived(d?.summary ?? null);
  const leaves = $derived(s ? summaryLeaves(s) : []);
</script>

{#if gone}
  <p class="muted" data-testid="proxy-gone">This proxy does not exist (any more). <a href="#/accounts/{accountId}/proxies">Proxies</a></p>
{:else if d}
  <section class="card grid">
    <div class="row">
      <a href="#/accounts/{accountId}/proxies" class="muted">Proxies</a><span class="muted">/</span>
      <h2 data-testid="proxy-title">{d.proxy.displayName}</h2><span class="mono muted">{d.proxy.name}</span>
      <StateChip state={d.view.state} testid="live-state" />
      {#if d.view.stale}<span class="badge">stale (before the last restart)</span>{/if}
    </div>
    <div class="row muted">
      <span>last heartbeat <Ago t={d.view.lastHeartbeatAt} testid="live-age" /></span>
      <span>· {d.view.connected ? 'connected' : 'not connected'}{d.view.closedReason && !d.view.connected ? ` (${d.view.closedReason})` : ''}</span>
      {#if d.view.version}<span class="mono">· {d.view.version}</span>{/if}
      {#if d.view.skewMs !== null}<span class:warn={d.view.skewProblem} data-testid="skew">· clock {d.view.skewMs > 0 ? '+' : ''}{Math.round(d.view.skewMs / 1000)} s</span>{/if}
    </div>
    {#if error}<p class="error" data-testid="proxy-error">{error}</p>{/if}
  </section>

  <section class="card grid" data-testid="live-status">
    <h3>Live status</h3>
    {#if !s}
      <p class="muted">No heartbeat yet.</p>
    {:else if s.unreadable}
      <p class="badge bad" data-testid="unreadable">{s.unreadable}</p>
    {:else}
      <div class="row">
        <span class="chip {s.ok ? 'ok' : 'bad'}" data-testid="summary-ok">{s.ok ? 'no problems' : `${s.problemCount} problem${s.problemCount === 1 ? '' : 's'}`}</span>
        <span class="muted">generated {when(s.generatedAt)}</span>{#if s.$truncated}<span class="badge">truncated</span>{/if}
      </div>
      <table data-testid="summary-items">
        <tbody>
          {#each s.items as it}
            <tr class:problem={it.problem} data-testid="item-{it.id}"><td>{it.label}</td><td>{it.text}</td><td>{it.problem ? '⚠' : ''}</td></tr>
          {/each}
        </tbody>
      </table>
      {#each s.cameras ?? [] as c (c.camera.id)}
        <div class="cam" data-testid="summary-camera-{c.camera.id}">
          <div class="row"><span class="chip {camClass(d.view.state === 'online' ? c.camera.online : null)}">{c.camera.name}</span><span class="mono muted">{c.camera.id} · {c.camera.address}{c.camera.model ? ` · ${c.camera.model}` : ''}</span></div>
          <div class="row items">{#each c.items as it}<span class="badge" class:bad={it.problem}>{it.label}: {it.text}</span>{/each}</div>
        </div>
      {/each}
      <button class="btn" data-testid="all-fields-toggle" onclick={() => (showAll = !showAll)}>{showAll ? 'Hide' : 'All fields'} ({leaves.length})</button>
      {#if showAll}
        <table class="mono all" data-testid="all-fields">
          <tbody>{#each leaves as l (l.path)}<tr><td>{l.path}</td><td data-testid="sum-{l.path}">{l.text}</td></tr>{/each}</tbody>
        </table>
      {/if}
    {/if}
  </section>

  <section class="card grid" data-testid="reconcile">
    <h3>Reconciliation</h3>
    <div class="row">
      Pin: <span class="badge" class:bad={d.view.pin === 'mismatch'} data-testid="pin-status">{d.view.pin === 'match' ? 'matches' : d.view.pin === 'mismatch' ? 'MISMATCH: cams will refuse this proxy' : d.view.pin === 'hint' ? 'the proxy has a site CA but no pin is registered' : 'no site CA reported'}</span>
      {#if d.reported?.caFingerprint?.length}<span class="mono muted">reported {d.reported.caFingerprint.join(', ')}</span>{/if}
    </div>
    {#each d.reconcile.reportedNotRegistered as r}
      <div class="row" data-testid="reconcile-reported-{r.ref}">
        <span class="badge warn">reported, not registered</span><span class="mono">{r.ref}</span>
        <button class="btn" data-testid="adopt-{r.ref}" onclick={() => adopt(r.ref, r.proposedCamsId)}>Add to account as {r.proposedCamsId}</button>
      </div>
    {/each}
    {#each d.reconcile.registeredNotReported as ref}
      <div class="row" data-testid="reconcile-registered-{ref}"><span class="badge warn">registered, not reported</span><span class="mono">{ref}</span></div>
    {/each}
    {#if !d.reconcile.reportedNotRegistered.length && !d.reconcile.registeredNotReported.length}<p class="muted">Registry and proxy agree on the cameras.</p>{/if}
  </section>

  <section class="card grid" data-testid="enrollment">
    <h3>Enrollment and keys</h3>
    {#if shownCode}
      <div class="codebox grid" data-testid="code-box">
        <p>Shown <b>once</b>. Enter it on the proxy (CLI or its Status page's cams-admin card); it expires {when(shownCode.expiresAt)}.</p>
        <div class="row"><code class="mono big" data-testid="code-value">{shownCode.code}</code><button class="btn" onclick={() => copy(shownCode!.code)}>Copy</button></div>
        <div class="row"><code class="mono" data-testid="code-command">{shownCode.command}</code><button class="btn" onclick={() => copy(shownCode!.command)}>Copy</button></div>
        <p class="muted">The command asks for the code on stdin; never pass it as an argument.</p>
      </div>
    {/if}
    <div class="row">
      {#if d.proxy.state !== 'revoked'}
        <label>Lifetime<select bind:value={lifetimeH} data-testid="code-lifetime"><option value={1}>1 h</option><option value={24}>24 h</option><option value={168}>7 d</option></select></label>
        <button class="btn primary" data-testid="code-create" onclick={createCode}>Create enrollment code</button>
      {/if}
      {#if d.enrollment}
        <span class="muted" data-testid="code-live">a code is live until {when(d.enrollment.expiresAt)}</span>
        <button class="btn" data-testid="code-cancel" onclick={cancelCode}>Cancel code</button>
      {/if}
    </div>
    <div class="scroll-x">
      <table>
        <thead><tr><th>Key fingerprint</th><th>Created</th><th>Last seen</th><th>State</th><th></th></tr></thead>
        <tbody>
          {#each d.keys as k (k.id)}
            <tr data-testid="key-row-{k.id}">
              <td class="mono">{k.fingerprint}</td><td>{when(k.createdAt)}</td><td>{when(k.lastSeenAt)}</td>
              <td data-testid="key-state-{k.id}" class:muted={!!k.pending}>{keyState(k)}</td>
              <td>{#if !k.revokedAt}<button class="btn danger" data-testid="key-revoke" onclick={() => (confirm = { kind: 'revoke', keyId: k.id })}>Revoke</button>{/if}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="row">
      {#if d.proxy.state !== 'revoked'}<button class="btn danger" data-testid="block-proxy" onclick={() => (confirm = { kind: 'block' })}>Block proxy</button>{/if}
      <button class="btn danger" data-testid="delete-proxy" onclick={() => (confirm = { kind: 'delete' })}>Delete proxy</button>
    </div>
  </section>

  <section class="card grid" data-testid="registry-fields">
    <h3>Registry</h3>
    <div class="grid two">
      <label>Display name<input bind:value={f.displayName} /></label>
      <label>Runs on<select bind:value={f.runsOn}><option>local-host</option><option>cluster</option><option>cloud</option></select></label>
      <label>Host<select bind:value={f.hostKind}><option value="">—</option>{#each ['pi', 'mini-pc', 'pc', 'mac', 'vm', 'container', 'other'] as k}<option>{k}</option>{/each}</select></label>
      <label>URL (how cams reaches it)<input bind:value={f.url} data-testid="proxy-url" /></label>
      <label>Admin UI URL<input bind:value={f.adminUiUrl} /></label>
      <label>DNS name<input bind:value={f.dnsName} /></label>
      <label>TLS site<input bind:value={f.tlsSite} /></label>
      <label>TLS server name<input bind:value={f.tlsServername} /></label>
      <label class="wide">Site CA fingerprints (cams's pins; 0–2, from the proxy's Certificates card)<textarea rows="2" class="mono" bind:value={f.fps} data-testid="proxy-fingerprints"></textarea></label>
      <label class="wide">Notes<textarea rows="2" bind:value={f.notes}></textarea></label>
    </div>
    <div><button class="btn primary" data-testid="proxy-save" onclick={save}>Save</button></div>
  </section>

  <section class="card grid" data-testid="history">
    <h3>History</h3>
    {#each events as e (e.id)}
      <div class="row event" data-testid="event-{e.kind}"><span class="muted">{when(e.at)}</span><b>{e.kind}</b>{#if e.cameraRef}<span class="mono">{e.cameraRef}</span>{/if}{#if e.detail}<span class="mono muted">{JSON.stringify(e.detail)}</span>{/if}</div>
    {:else}
      <p class="muted">No events yet.</p>
    {/each}
  </section>

  {#if confirm}
    <Confirm
      title={confirm.kind === 'revoke' ? 'Revoke this key' : confirm.kind === 'block' ? `Block ${d.proxy.name}` : `Delete ${d.proxy.name}`}
      body={confirm.kind === 'revoke' ? 'The proxy is disconnected and must be re-enrolled with a new code.' : confirm.kind === 'block' ? 'The proxy is disconnected, its key and any live code die, and it cannot enroll again until unblocked by deleting and re-adding it.' : 'Its keys are revoked and it is disconnected; its cameras stay in the account without a proxy.'}
      ok={confirm.kind === 'revoke' ? 'Revoke' : confirm.kind === 'block' ? 'Block' : 'Delete'}
      onconfirm={act} oncancel={() => (confirm = null)} />
  {/if}
{:else if error}
  <p class="error">{error}</p>
{:else}
  <p class="muted">Loading…</p>
{/if}

<style>
  h2, h3 { margin: 0; }
  .two { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
  .wide { grid-column: 1 / -1; }
  tr.problem td { color: var(--danger); }
  .cam { border-top: 1px solid var(--border); padding-top: 6px; display: grid; gap: 4px; }
  .items { gap: 4px; }
  .codebox { border: 1px dashed var(--accent); border-radius: 8px; padding: 12px; }
  .big { font-size: 18px; letter-spacing: 1px; }
  .all td:first-child { color: var(--muted); }
  .warn { color: var(--warning); }
  .event { font-size: 13px; }
</style>
