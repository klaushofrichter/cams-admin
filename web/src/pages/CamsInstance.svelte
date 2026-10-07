<script lang="ts">
  // P4: one cams instance: served accounts, routes, enrollment, keys, status.
  import { onMount } from 'svelte';
  import { api, errorText } from '../lib/api';
  import { live } from '../lib/live';
  import { instanceState, stateClass, stateText } from '../lib/cams';
  import { clock } from '../lib/clock.svelte';
  import { when } from '../lib/format';
  import Ago from '../components/Ago.svelte';
  import Confirm from '../components/Confirm.svelte';

  let { instanceId }: { instanceId: string } = $props();
  let inst = $state<any>(null);
  let accounts = $state<any[]>([]);
  let proxies = $state<any[]>([]);
  let routes = $state<any[]>([]);
  let keys = $state<any[]>([]);
  let row = $state<any>(null);
  let served = $state<Record<string, boolean>>({});
  let edit = $state<Record<string, { url: string; hidden: boolean }>>({});
  let code = $state<any>(null);
  let stored = $state(false);
  let confirm = $state<'' | 'block' | 'delete' | 'rotate'>('');
  let error = $state('');
  let notFound = $state(false);

  async function load() {
    try {
      inst = await api('GET', `/cams-instances/${instanceId}`);
      const [a, r, k, d] = await Promise.all([api('GET', '/accounts'), api('GET', `/cams-instances/${instanceId}/routes`), api('GET', `/cams-instances/${instanceId}/keys`), api('GET', '/dashboard')]);
      accounts = a.items;
      routes = r.items;
      keys = k.items;
      row = d.cams.find((c: any) => c.id === instanceId) ?? null;
      served = Object.fromEntries(accounts.map((x) => [x.id, inst.accounts.includes(x.id)]));
      proxies = (await Promise.all(inst.accounts.map((id: string) => api('GET', `/accounts/${id}/proxies`).then((x) => x.items.map((p: any) => ({ ...p, accountName: accounts.find((y) => y.id === id)?.name })))))).flat();
      // Edit buffers: kept while open (a reload from a live event never
      // wipes what is being typed); a saved or removed route resets its own.
      edit = Object.fromEntries(proxies.map((p) => [p.id, edit[p.id] ?? fromRoute(p.id)]));
    } catch (e: any) {
      if (e?.status === 404) notFound = true;
      else error = errorText(e);
    }
  }
  onMount(() => {
    load();
    return live({ registry: (r) => { if (r.type === 'cams-instance' && r.id === instanceId && !code) load(); } });
  });
  const run = async (fn: () => Promise<unknown>) => {
    error = '';
    try { await fn(); await load(); } catch (e) { error = errorText(e); }
  };
  const saveAccounts = () => run(() => api('PATCH', `/cams-instances/${instanceId}`, { accounts: Object.keys(served).filter((k) => served[k]), version: inst.version }));
  const fromRoute = (proxyId: string) => {
    const rt = routes.find((x) => x.proxyId === proxyId);
    return { url: rt?.url ?? '', hidden: rt?.hidden ?? false };
  };
  const saveRoute = (p: any) => run(async () => { await api('PUT', `/cams-instances/${instanceId}/routes/${p.id}`, { url: edit[p.id].url || null, hidden: edit[p.id].hidden }); delete edit[p.id]; });
  const removeRoute = (p: any) => run(async () => { await api('DELETE', `/cams-instances/${instanceId}/routes/${p.id}`); delete edit[p.id]; });
  const revokeKey = (k: any) => run(() => api('POST', `/cams-instances/${instanceId}/keys/${k.id}/revoke`));
  async function newCode() {
    error = '';
    try { code = await api('POST', `/cams-instances/${instanceId}/enrollment-codes`, { lifetimeH: 24 }); stored = false; } catch (e) { error = errorText(e); }
  }
  async function closeCode() { code = null; await load(); }
  async function doConfirm() {
    const what = confirm;
    confirm = '';
    if (what === 'rotate') return run(() => api('POST', `/cams-instances/${instanceId}/rotate`));
    if (what === 'block') return run(() => api('POST', `/cams-instances/${instanceId}/block`));
    if (what === 'delete') {
      try { await api('DELETE', `/cams-instances/${instanceId}`, { confirmName: inst.name }); location.hash = '#/cams-instances'; } catch (e) { error = errorText(e); }
    }
  }
  const routeOf = (p: any) => routes.find((x) => x.proxyId === p.id);
  const keyState = (k: any) => (k.revokedAt ? `revoked (${k.revokedReason})` : k.confirmedAt ? 'active' : 'pending: waiting for its first signed request');
  const st = $derived(row ? instanceState(row, clock.now) : 'never');
  const report = $derived(inst?.live?.report ?? null);
</script>

{#if notFound}
  <p class="muted" data-testid="cms-gone">This cams instance does not exist (any more). <a href="#/cams-instances">cams instances</a></p>
{:else if inst}
  <section class="card grid">
    <div class="row"><a href="#/cams-instances" class="muted">cams instances</a><span class="muted">/</span><h2 data-testid="cms-title">{inst.displayName}</h2><span class="mono muted">{inst.name}</span>
      <span class="chip {inst.state === 'enrolled' ? 'ok' : inst.state === 'revoked' ? 'bad' : ''}" data-testid="cms-state">{inst.state === 'revoked' ? 'blocked' : inst.state}</span></div>
    {#if error}<p class="error" data-testid="cms-detail-error">{error}</p>{/if}

    <h3>Status</h3>
    <div class="grid two" data-testid="cms-status">
      <div>State <span class="chip {stateClass(st)}" data-testid="cms-health">{stateText(st)}</span></div>
      <div>Last request <Ago t={inst.live.lastSeenAt} /></div>
      <div>Last pull <Ago t={inst.live.lastPullAt} testid="cms-last-pull" />{inst.live.lastPullStatus ? ` (${inst.live.lastPullStatus})` : ''}</div>
      <div>Mode <b data-testid="cms-mode">{report?.mode ?? '—'}</b>{report?.version ? ` · cams ${report.version}` : ''}</div>
      <div>Revision <span class="mono">{report?.appliedRevision ?? '—'}</span> {#if report}<span class="badge {row?.current ? '' : 'warn'}" data-testid="cms-current">{row?.current ? 'current' : `current is ${inst.revision}`}</span>{/if}</div>
      {#if report?.shadow}<div data-testid="cms-shadow">Shadow differences <b>{report.shadow.differences}</b>{inst.live.shadowZeroSince ? ` · zero since ${when(inst.live.shadowZeroSince)}` : ''}</div>{/if}
      {#if report?.tokens}<div>Tokens: managed {report.tokens.managed}, pending {report.tokens.pending}, legacy {report.tokens.legacy}</div>{/if}
    </div>
    {#if report?.held?.length}<div data-testid="cms-held"><b>Held changes</b> (cams waits for an account admin):{#each report.held as h}<div class="mono">{accounts.find((a) => a.id === h.accountId)?.name ?? h.accountId}/{h.camsId}: {h.fields.join(', ')}</div>{/each}</div>{/if}
    {#if report?.keptOld?.length}<div data-testid="cms-kept-old"><b>Kept old values</b>:{#each report.keptOld as h}<div class="mono">{accounts.find((a) => a.id === h.accountId)?.name ?? h.accountId}/{h.camsId}: {h.fields.join(', ')}</div>{/each}</div>{/if}
    {#if report?.shadow?.items?.length}<div><b>Shadow differences</b>{#each report.shadow.items as it}<div class="mono">{it}</div>{/each}</div>{/if}
    {#if report?.problems?.length}<div data-testid="cms-problems"><b>Problems</b>{#each report.problems as p}<div class="mono">{p.code}{p.detail ? `: ${p.detail}` : ''}</div>{/each}</div>{/if}
    <div class="row">
      <button class="btn" data-testid="cms-rotate" onclick={() => (confirm = 'rotate')} disabled={inst.state === 'revoked'}>Rotate tokens now</button>
      {#if inst.rotateBefore}<span class="muted">last rotation asked {when(inst.rotateBefore)}</span>{/if}
    </div>

    <h3>Served accounts</h3>
    <div class="row" data-testid="cms-served">
      {#each accounts as a (a.id)}<label class="check"><input type="checkbox" bind:checked={served[a.id]} data-testid="cms-serve-{a.name}" /> {a.displayName}</label>{/each}
      <button class="btn" data-testid="cms-served-save" onclick={saveAccounts}>Save</button>
    </div>

    <h3>Routes</h3>
    <p class="muted">Per proxy: the URL this instance uses (else the proxy's registered URL), or hidden for this instance (the proxy and its cameras are left out of its configuration).</p>
    <div class="scroll-x">
      <table>
        <thead><tr><th>Proxy</th><th class="hide-phone">Registered URL</th><th>Route</th><th>Hidden</th><th></th></tr></thead>
        <tbody>
          {#each proxies as p (p.id)}
            {#if edit[p.id]}
              <tr data-testid="route-row-{p.name}">
                <td>{p.displayName} <span class="mono muted">{p.accountName}/{p.name}</span></td>
                <td class="hide-phone mono">{p.url ?? '—'}</td>
                <td><input class="mono" bind:value={edit[p.id].url} placeholder="(registered URL)" data-testid="route-url-{p.name}" disabled={edit[p.id].hidden} /></td>
                <td><input type="checkbox" bind:checked={edit[p.id].hidden} data-testid="route-hidden-{p.name}" /></td>
                <td class="row"><button class="btn" data-testid="route-save-{p.name}" onclick={() => saveRoute(p)}>Save</button>{#if routeOf(p)}<button class="btn" data-testid="route-remove-{p.name}" onclick={() => removeRoute(p)}>Remove</button>{/if}</td>
              </tr>
            {/if}
          {/each}
          {#if !proxies.length}<tr><td colspan="5" class="muted">The served accounts have no proxies.</td></tr>{/if}
        </tbody>
      </table>
    </div>

    <h3>Enrollment</h3>
    <div class="row">
      <button class="btn primary" data-testid="cms-code" onclick={newCode} disabled={inst.state === 'revoked'}>New enrollment code</button>
      {#if inst.enrollment}<span class="muted" data-testid="cms-live-code">a code is open until {when(inst.enrollment.expiresAt)}</span>{/if}
      <span class="muted">cams-admin's key: <span class="mono" data-testid="cms-server-fp">{inst.serverKeyFingerprints[0]}</span></span>
    </div>

    <h3>Keys</h3>
    <div class="scroll-x">
      <table>
        <thead><tr><th>Fingerprint</th><th>State</th><th class="hide-phone">Created</th><th></th></tr></thead>
        <tbody>
          {#each keys as k (k.id)}
            <tr data-testid="cms-key-{k.id}">
              <td class="mono">{k.fingerprint.slice(0, 23)}…</td>
              <td>{keyState(k)}</td>
              <td class="hide-phone">{when(k.createdAt)}</td>
              <td>{#if !k.revokedAt}<button class="btn danger" data-testid="cms-key-revoke" onclick={() => revokeKey(k)}>Revoke</button>{/if}</td>
            </tr>
          {/each}
          {#if !keys.length}<tr><td colspan="4" class="muted">Not enrolled yet.</td></tr>{/if}
        </tbody>
      </table>
    </div>

    <div class="row">
      <button class="btn danger" data-testid="cms-block" onclick={() => (confirm = 'block')} disabled={inst.state === 'revoked'}>Block</button>
      <button class="btn danger" data-testid="cms-delete" onclick={() => (confirm = 'delete')}>Delete instance</button>
    </div>
  </section>

  {#if code}
    <div class="scrim" role="presentation"></div>
    <div class="dialog card" role="dialog" aria-modal="true" aria-label="Enrollment code" data-testid="cms-code-dialog">
      <h3>Enrollment code for {inst.name}</h3>
      <input class="mono" readonly value={code.code} data-testid="cms-code-value" autocomplete="off" spellcheck="false" />
      <p>Shown once, valid until {when(code.expiresAt)}. Run on the cams host and paste the code when asked:</p>
      <div class="mono cmd" data-testid="cms-cmd-cluster">{code.command.cluster}</div>
      <div class="mono cmd" data-testid="cms-cmd-pi">{code.command.pi}</div>
      <p>Compare this fingerprint with what <code>admin-enroll</code> prints: <span class="mono" data-testid="cms-code-fp">{code.serverKeyFingerprints[0]}</span></p>
      <label class="check"><input type="checkbox" bind:checked={stored} data-testid="cms-code-stored" /> I have used or stored it</label>
      <div class="row end"><button class="btn primary" data-testid="cms-code-close" disabled={!stored} onclick={closeCode}>Close</button></div>
    </div>
  {/if}
  {#if confirm === 'rotate'}<Confirm title="Rotate tokens of {inst.name}" body="cams registers new client and admin tokens for every proxy and retires its current ones (24 h)." ok="Rotate" onconfirm={doConfirm} oncancel={() => (confirm = '')} />{/if}
  {#if confirm === 'block'}<Confirm title="Block {inst.name}" body="Its keys and every token it holds are revoked at once; it can't pull its configuration any more. A new enrollment needs a new instance." typed={inst.name} ok="Block" onconfirm={doConfirm} oncancel={() => (confirm = '')} />{/if}
  {#if confirm === 'delete'}<Confirm title="Delete {inst.name}" body="Its keys, routes and codes go, and every token it holds is revoked." typed={inst.name} ok="Delete" onconfirm={doConfirm} oncancel={() => (confirm = '')} />{/if}
{:else if error}
  <p class="error">{error}</p>
{/if}

<style>
  h2, h3 { margin: 0; }
  h3 { margin-top: 8px; font-size: 16px; }
  .two { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
  .check { display: flex; flex-direction: row; align-items: center; gap: 4px; color: var(--text); }
  .scrim { position: fixed; inset: 0; background: var(--scrim); z-index: 10; }
  .dialog { position: fixed; z-index: 11; left: 50%; top: 10%; transform: translateX(-50%); width: min(640px, calc(100vw - 32px)); box-shadow: var(--shadow); display: grid; gap: 10px; }
  .dialog p { margin: 0; }
  .cmd { background: var(--surface-2); border-radius: 6px; padding: 6px 8px; }
  .end { justify-content: flex-end; }
</style>
