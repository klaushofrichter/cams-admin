<script lang="ts">
  import { onMount } from 'svelte';
  import { api, errorText } from '../lib/api';
  import { coalesced, live } from '../lib/live';
  import { camClass, keyState, when } from '../lib/format';
  import { phaseText } from '../lib/moves';
  import { addressInfo } from '../lib/address';
  import { keepEdits } from '../lib/edits';
  import { proxyForm, proxyPatch, validProxyName } from '../lib/proxy';
  import { summaryLeaves } from '../lib/summaryTree';
  import { proxyDeleteLines, type DeleteLines as Lines } from '../lib/deletes';
  import StateChip from '../components/StateChip.svelte';
  import Ago from '../components/Ago.svelte';
  import Confirm from '../components/Confirm.svelte';
  import DeleteLines from '../components/DeleteLines.svelte';
  import DecommissionProxy from '../components/DecommissionProxy.svelte';
  import ProxyCommands from '../components/ProxyCommands.svelte';
  import ProxyTokens from '../components/ProxyTokens.svelte';
  import ProxySettings from '../components/ProxySettings.svelte';
  import ProxyCameraActions from '../components/ProxyCameraActions.svelte';
  import ProxyProfile from '../components/ProxyProfile.svelte';
  import CameraOnboarding from '../components/CameraOnboarding.svelte';

  let { accountId, proxyId, camera = undefined }: { accountId: string; proxyId: string; camera?: string } = $props();

  let d = $state<any>(null);
  let events = $state<any[]>([]);
  let error = $state('');
  let gone = $state(false);
  let shownCode = $state<{ id: string; code: string; command: string; expiresAt: number } | null>(null);
  let lifetimeH = $state(24);
  // Finding 10: read the select itself when sending, so a value set without a change event is still the one sent.
  let lifetimeSel = $state<HTMLSelectElement | null>(null);
  let confirm = $state<null | { kind: 'revoke' | 'block' | 'delete'; keyId?: string }>(null);
  let deleteLines = $state<Lines | null>(null);
  // Decommission (spec 2026-11-08 B5): its panel is open.
  let decommissioning = $state(false);
  let showAll = $state(false);
  let activeMove = $state<any>(null);
  let refresh = $state(0); // bumps after every load: the command and token cards reload with it
  let f = $state<Record<string, string>>({});
  let formSeen: Record<string, string> = {};
  let formError = $state('');

  async function load() {
    try {
      d = await api('GET', `/accounts/${accountId}/proxies/${proxyId}/status`);
      // A reload keeps what is being typed; a field the server changed takes the server's value.
      const fresh = proxyForm(d.proxy);
      f = keepEdits(f, formSeen, fresh);
      formSeen = fresh;
      events = (await api('GET', `/accounts/${accountId}/proxies/${proxyId}/status-events?limit=30`)).items;
      activeMove = (await api('GET', `/moves?accountId=${accountId}`)).items.find((m: any) => m.endedAt === null && (m.source.id === proxyId || m.target.id === proxyId)) ?? null;
      refresh++;
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
  const FIELD_ERROR: Record<string, string> = {
    adminUiUrl: 'Not valid: the GUI address starts with http:// or https://, without a user name, query or fragment.',
    url: 'Not valid: the URL starts with http:// or https://, without a user name, query or fragment.',
    displayName: 'Not valid: the display name is needed, at most 80 characters.',
    notes: 'Not valid: notes are at most 2000 characters.',
  };
  async function save(e: Event) {
    e.preventDefault();
    formError = '';
    try {
      await api('PATCH', `/accounts/${accountId}/proxies/${proxyId}`, { ...patch, version: d.proxy.version });
      await load();
    } catch (err: any) {
      formError = (err?.code === 'invalid' && FIELD_ERROR[err.field]) || errorText(err);
      // The buffer stays; the fresh version makes the next Save possible.
      if (err?.code === 'conflict') await load();
    }
  }

  // --- enrollment and keys ----------------------------------------------------------------------
  async function createCode() {
    error = '';
    try {
      const c = await api('POST', `/accounts/${accountId}/proxies/${proxyId}/enrollment-codes`, { lifetimeH: Number(lifetimeSel?.value || lifetimeH) });
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
  // The Delete dialog names what goes and what stays (counts from the server).
  async function askDelete() {
    deleteLines = null;
    confirm = { kind: 'delete' };
    try { deleteLines = proxyDeleteLines(await api('GET', `/accounts/${accountId}/proxies/${proxyId}/delete-preview`)); } catch (e) { confirm = null; error = errorText(e); }
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
  // The proxy's reported site-CA pins into the registry (a change is held in each cams viewer until confirmed there).
  async function usePins() {
    error = '';
    try { await api('POST', `/accounts/${accountId}/proxies/${proxyId}/pins/from-report`, {}); await load(); } catch (e) { error = errorText(e); }
  }
  const copy = (t: string) => navigator.clipboard?.writeText(t);

  const s = $derived(d?.summary ?? null);
  const leaves = $derived(s ? summaryLeaves(s) : []);
  const address = $derived(addressInfo(d?.proxy.adminUiUrl));
  const patch = $derived(d && f.name !== undefined ? proxyPatch(f as any, proxyForm(d.proxy)) : {});
  const nameOk = $derived(validProxyName(f.name ?? ''));
</script>

{#if gone && decommissioning}
  <!-- The decommission's done answer deleted the record (the live reload finds it gone first). -->
  <p data-testid="decommission-done">The proxy unenrolled itself and its record is deleted. <a href="#/accounts/{accountId}/proxies" data-testid="decommission-close">Proxies</a></p>
{:else if gone}
  <p class="muted" data-testid="proxy-gone">This proxy does not exist (any more). <a href="#/accounts/{accountId}/proxies">Proxies</a></p>
{:else if d}
  <section class="card grid">
    <div class="row">
      <a href="#/accounts/{accountId}/proxies" class="muted">Proxies</a><span class="muted">/</span>
      <h2 data-testid="proxy-title">{d.proxy.displayName}</h2><span class="mono muted">{d.proxy.name}</span>
      <StateChip state={d.view.state} testid="live-state" />
      {#if d.view.stale}<span class="badge">stale (before the last restart)</span>{/if}
      {#if address.href}<a class="mono" href={address.href} target="_blank" rel="noopener noreferrer" data-testid="proxy-address">{d.proxy.adminUiUrl}</a>
      {:else if d.proxy.adminUiUrl}<span class="mono" data-testid="proxy-address-text">{d.proxy.adminUiUrl}</span>
      {:else}<button type="button" class="plain muted" data-testid="proxy-no-address" onclick={() => document.getElementById('proxy-edit-address')?.focus()}>no GUI address set: enter it under Registry</button>{/if}
      {#if address.warning}<span class="badge warn" data-testid="proxy-address-warning">{address.warning}</span>{/if}
    </div>
    <div class="row muted">
      <span>last heartbeat <Ago t={d.view.lastHeartbeatAt} testid="live-age" /></span>
      <span>· {d.view.connected ? 'connected' : 'not connected'}{d.view.closedReason && !d.view.connected ? ` (${d.view.closedReason})` : ''}</span>
      {#if d.view.version}<span class="mono">· {d.view.version}</span>{/if}
      {#if d.view.skewMs !== null}<span class:warn={d.view.skewProblem} data-testid="skew">· clock {d.view.skewMs > 0 ? '+' : ''}{Math.round(d.view.skewMs / 1000)} s</span>{/if}
    </div>
    {#if activeMove}<p data-testid="proxy-active-move">Camera move in progress: <a href="#/moves">{activeMove.cameraName} from {activeMove.source.name} to {activeMove.target.name}</a> ({phaseText(activeMove.phase)}).</p>{/if}
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
          <div class="row"><span class="chip {camClass(d.view.state === 'online' ? c.camera.online : null)}">{c.camera.name}</span><span class="mono muted">{c.camera.id} · {c.camera.address}{c.camera.model ? ` · ${c.camera.model}` : ''}</span>
            {#if d.reported?.onboarding?.[c.camera.id]}{@const o = d.reported.onboarding[c.camera.id]}<a class="chip {o.ready ? 'ok' : 'bad'}" href="#/accounts/{accountId}/proxies/{proxyId}?camera={encodeURIComponent(c.camera.id)}" data-testid="onboarding-chip-{c.camera.id}" title={o.missing.length ? `missing: ${o.missing.join(', ')}` : 'every step done'}>{o.ready ? 'onboarded' : 'onboarding'}</a>{/if}</div>
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

  <ProxyProfile profile={d.reported?.profile ?? null} unreadable={d.reported?.profileUnreadable === true} runsOn={d.proxy.runsOn} />
  {#if camera}<CameraOnboarding {accountId} {proxyId} {camera} {refresh} />{/if}
  <ProxyCameraActions {accountId} {proxyId} {refresh} {camera} />
  <ProxySettings {accountId} {proxyId} policy={d.view.commands} {refresh} />
  <ProxyCommands {accountId} {proxyId} policy={d.view.commands} allow={d.view.allow} {refresh} />
  <ProxyTokens {accountId} {proxyId} proxyName={d.proxy.name} policy={d.view.commands} allow={d.view.allow} {refresh} />

  <section class="card grid" data-testid="reconcile">
    <h3>Reconciliation</h3>
    <div class="row">
      Pin: <span class="badge" class:bad={d.view.pin === 'mismatch'} data-testid="pin-status">{d.view.pin === 'match' ? 'matches' : d.view.pin === 'mismatch' ? 'MISMATCH: cams will refuse this proxy' : d.view.pin === 'hint' ? 'the proxy has a site CA but no pin is registered' : 'no site CA reported'}</span>
      {#if d.reported?.caFingerprint?.length}<span class="mono muted">reported {d.reported.caFingerprint.join(', ')}</span>{/if}
      {#if (d.view.pin === 'mismatch' || d.view.pin === 'hint') && d.reported?.caFingerprint?.length}
        <button class="btn" data-testid="pins-from-report" onclick={usePins}>Use the reported pins</button>
      {/if}
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
        <label>Lifetime<select bind:value={lifetimeH} bind:this={lifetimeSel} data-testid="code-lifetime"><option value={1}>1 h</option><option value={24}>24 h</option><option value={168}>7 d</option></select></label>
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
      <button class="btn danger" data-testid="decommission-proxy" onclick={() => (decommissioning = true)}>Decommission…</button>
      <button class="btn danger" data-testid="delete-proxy" onclick={askDelete}>Delete proxy</button>
    </div>
  </section>

  <section class="card grid" data-testid="registry-fields">
    <h3>Registry</h3>
    <form class="grid two" onsubmit={save} data-testid="proxy-details">
      <label>Display name<input bind:value={f.displayName} data-testid="proxy-edit-display" /></label>
      <label>Name<input class="mono" bind:value={f.name} data-testid="proxy-edit-name" aria-invalid={!nameOk} /></label>
      <label>Runs on<select bind:value={f.runsOn}><option>local-host</option><option>cluster</option><option>cloud</option></select></label>
      <label>Host<select bind:value={f.hostKind}><option value="">—</option>{#each ['pi', 'mini-pc', 'pc', 'mac', 'vm', 'container', 'other'] as k}<option>{k}</option>{/each}</select></label>
      <label>URL (how cams reaches it)<input bind:value={f.url} data-testid="proxy-url" /></label>
      <label>GUI address (Admin UI URL)<input id="proxy-edit-address" class="mono" bind:value={f.adminUiUrl} placeholder="https://proxy.example.net:8480" data-testid="proxy-edit-address" /></label>
      <label>DNS name<input bind:value={f.dnsName} /></label>
      <label>TLS site<input bind:value={f.tlsSite} /></label>
      <label>TLS server name<input bind:value={f.tlsServername} /></label>
      <label class="wide">Site CA fingerprints (cams's pins; 0–2; taken from the proxy's report on its first heartbeat, a change with "Use the reported pins" above)<textarea rows="2" class="mono" bind:value={f.fps} data-testid="proxy-fingerprints"></textarea></label>
      <label class="wide">Notes<textarea rows="2" bind:value={f.notes}></textarea></label>
      <p class="muted wide">The name is the short label in lists, audit records and the suggested id of a camera whose id is taken. The proxy, its keys, tokens, routes and moves go by the proxy id, so a rename is safe: cams shows it from its next snapshot, and a move already running keeps the old name in its messages.</p>
      {#if !nameOk}<p class="error wide" data-testid="proxy-name-error">Name: lower-case letters, digits and hyphens, starting with a letter or digit, at most 32 characters.</p>{/if}
      {#if formError}<p class="error wide" data-testid="proxy-form-error">{formError}</p>{/if}
      <div class="row wide"><button class="btn primary" data-testid="proxy-save" disabled={!nameOk || !Object.keys(patch).length}>Save</button></div>
    </form>
  </section>

  <section class="card grid" data-testid="history">
    <h3>History</h3>
    {#each events as e (e.id)}
      <div class="row event" data-testid="event-{e.kind}"><span class="muted">{when(e.at)}</span><b>{e.kind}</b>{#if e.cameraRef}<span class="mono">{e.cameraRef}</span>{/if}{#if e.detail}<span class="mono muted">{JSON.stringify(e.detail)}</span>{/if}</div>
    {:else}
      <p class="muted">No events yet.</p>
    {/each}
  </section>

  {#if decommissioning}
    <DecommissionProxy {accountId} proxy={d.proxy} onclose={() => (decommissioning = false)} ondeleterecord={() => { decommissioning = false; askDelete(); }} />
  {/if}
  {#if confirm}
    <Confirm
      title={confirm.kind === 'revoke' ? 'Revoke this key' : confirm.kind === 'block' ? `Block ${d.proxy.name}` : `Delete ${d.proxy.name}`}
      body={confirm.kind === 'revoke' ? 'The proxy is disconnected and must be re-enrolled with a new code.' : confirm.kind === 'block' ? 'The proxy is disconnected, its key and any live code die, and it cannot enroll again until unblocked by deleting and re-adding it.' : 'The proxy record goes. To use the proxy again, add it anew and enroll it with a new code; a restore from backup is the only undo.'}
      ok={confirm.kind === 'revoke' ? 'Revoke' : confirm.kind === 'block' ? 'Block' : 'Delete'}
      okDisabled={confirm.kind === 'delete' && (!deleteLines || !!deleteLines.blocked)}
      onconfirm={act} oncancel={() => (confirm = null)}>
      {#if confirm.kind === 'delete'}<DeleteLines lines={deleteLines} testid="proxy-delete-lines" />{/if}
    </Confirm>
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
  form p { margin: 0; }
  .plain { background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline; }
  tr.problem td { color: var(--danger); }
  .cam { border-top: 1px solid var(--border); padding-top: 6px; display: grid; gap: 4px; }
  .items { gap: 4px; }
  .codebox { border: 1px dashed var(--accent); border-radius: 8px; padding: 12px; }
  .big { font-size: 18px; letter-spacing: 1px; }
  .all td:first-child { color: var(--muted); }
  .warn { color: var(--warning); }
  .event { font-size: 13px; }
</style>
