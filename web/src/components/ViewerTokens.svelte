<script lang="ts">
  // Viewer tokens on an account's Users tab (design 2026-11-05): sign people
  // in to the cams viewers as viewers. The token itself is fetched only for
  // Copy and the QR window, kept in this component's state, and dropped on close.
  import { onMount } from 'svelte';
  import { api, errorText } from '../lib/api';
  import { live } from '../lib/live';
  import { when } from '../lib/format';
  import { ADMIN_WARNING, DEFAULT_VALIDITY_DAYS, ROLES, VALIDITY, linkHost, qrPath, roleClass, stateClass } from '../lib/viewerTokens';
  import Ago from './Ago.svelte';
  import Confirm from './Confirm.svelte';

  let { accountId }: { accountId: string } = $props();

  type Acc = { id: string; name: string; displayName: string };
  type Tok = { id: string; name: string; accounts: Acc[]; days: number; expiresAt: number; state: 'valid' | 'expired' | 'revoked'; lastUsedAt: number | null; version: number; role: 'viewer' | 'admin' };
  let items = $state<Tok[]>([]);
  let all = $state<Acc[]>([]);
  let configured = $state(true);
  let error = $state('');

  async function load() {
    try {
      const r = await api('GET', `/viewer-tokens?account=${accountId}`);
      items = r.items;
      configured = r.configured;
      all = (await api('GET', '/accounts')).items.map((a: Acc) => ({ id: a.id, name: a.name, displayName: a.displayName }));
    } catch (e) { error = errorText(e); }
  }
  onMount(() => {
    load();
    return live({ registry: () => load() });
  });

  // --- add ------------------------------------------------------------------------------
  let name = $state('');
  let days = $state(DEFAULT_VALIDITY_DAYS);
  let role = $state<'viewer' | 'admin'>('viewer');
  let chosen = $state<Record<string, boolean>>({});
  $effect(() => { if (!(accountId in chosen)) chosen = { ...chosen, [accountId]: true }; });
  async function add(e: Event) {
    e.preventDefault();
    error = '';
    try {
      const r = await api('POST', '/viewer-tokens', { name, days, role, accountIds: Object.keys(chosen).filter((k) => chosen[k]) });
      name = '';
      days = DEFAULT_VALIDITY_DAYS;
      role = 'viewer';
      chosen = { [accountId]: true };
      qr = { name: r.item.name, link: r.link, ...qrPath(r.link) };
      await load();
    } catch (err) { error = errorText(err); }
  }

  // --- copy and QR --------------------------------------------------------------------------
  let copied = $state<Record<string, string>>({});
  const flash = (key: string, text: string) => {
    copied = { ...copied, [key]: text };
    setTimeout(() => { const { [key]: _, ...rest } = copied; copied = rest; }, 2000);
  };
  async function copyToken(t: Tok) {
    error = '';
    try {
      const r = await api('POST', `/viewer-tokens/${t.id}/copy`, { what: 'token' });
      await navigator.clipboard.writeText(r.token);
      flash(t.id, 'Copied');
    } catch (e) { flash(t.id, 'Copy failed'); if (!(e instanceof DOMException)) error = errorText(e); }
  }
  let qr = $state<{ name: string; link: string; size: number; path: string } | null>(null);
  async function openQr(t: Tok) {
    error = '';
    try {
      const r = await api('POST', `/viewer-tokens/${t.id}/copy`, { what: 'qr' });
      qr = { name: t.name, link: r.link, ...qrPath(r.link) };
    } catch (e) { error = errorText(e); }
  }
  async function copyLink() {
    if (!qr) return;
    try { await navigator.clipboard.writeText(qr.link); flash('qr', 'Copied'); } catch { flash('qr', 'Copy failed'); }
  }

  // --- validity, accounts, delete -------------------------------------------------------------
  let validityOf = $state<{ t: Tok; days: number } | null>(null);
  async function setValidity(revoke: boolean) {
    if (!validityOf) return;
    const { t, days: d } = validityOf;
    try {
      await api('POST', `/viewer-tokens/${t.id}/${revoke ? 'revoke' : 'validity'}`, revoke ? {} : { days: d });
      validityOf = null;
      await load();
    } catch (e) { error = errorText(e); }
  }
  let accountsOf = $state<{ t: Tok; pick: Record<string, boolean> } | null>(null);
  const editAccounts = (t: Tok) => (accountsOf = { t, pick: Object.fromEntries(t.accounts.map((a) => [a.id, true])) });
  async function saveAccounts() {
    if (!accountsOf) return;
    const { t, pick } = accountsOf;
    try {
      await api('PUT', `/viewer-tokens/${t.id}/accounts`, { accountIds: Object.keys(pick).filter((k) => pick[k]), version: t.version });
      accountsOf = null;
      await load();
    } catch (e) { error = errorText(e); }
  }
  // The role of one token: viewer or admin of its accounts (audited, every viewer of those accounts follows).
  async function setRole(t: Tok, r: string) {
    error = '';
    try { await api('POST', `/viewer-tokens/${t.id}/role`, { role: r }); await load(); } catch (e) { error = errorText(e); await load(); }
  }
  let deleting = $state<Tok | null>(null);
  async function remove() {
    if (!deleting) return;
    try { await api('DELETE', `/viewer-tokens/${deleting.id}`); deleting = null; await load(); } catch (e) { error = errorText(e); deleting = null; }
  }
</script>

<section class="grid" data-testid="vt-section">
  <h3>Tokens</h3>
  <p class="muted">A token signs a person in to the cams viewers as a <b>viewer</b> (or, if chosen, an <b>admin</b>) of its accounts, without a Google account, until it expires or is revoked. A revoke reaches the viewers within about a minute.</p>
  {#if !configured}<p class="badge warn" data-testid="vt-unconfigured">Tokens can't be created or copied: this server has no viewer token key (VIEWER_TOKEN_KEY_FILE).</p>{/if}
  <div class="scroll-x">
    <table>
      <thead><tr><th>Name</th><th>Accounts</th><th>Role</th><th>Valid until</th><th>Status</th><th class="hide-phone">Last used</th><th></th></tr></thead>
      <tbody>
        {#each items as t (t.id)}
          <tr data-testid="vt-row-{t.name}">
            <td>{t.name}</td>
            <td data-testid="vt-accounts-{t.name}">{t.accounts.map((a) => a.name).join(', ')}</td>
            <td><select class="role {roleClass(t.role)}" value={t.role} data-testid="vt-role-{t.name}" title={t.role === 'admin' ? ADMIN_WARNING : ''} onchange={(e) => setRole(t, (e.target as HTMLSelectElement).value)}>{#each ROLES as r}<option value={r.role}>{r.label}</option>{/each}</select></td>
            <td data-testid="vt-until-{t.name}">{when(t.expiresAt)}</td>
            <td><span class="chip {stateClass(t.state)}" data-testid="vt-state-{t.name}">{t.state}</span></td>
            <td class="hide-phone">{#if t.lastUsedAt}<Ago t={t.lastUsedAt} />{:else}<span class="muted">–</span>{/if}</td>
            <td class="row actions">
              <button class="btn" data-testid="vt-copy-{t.name}" disabled={!configured} onclick={() => copyToken(t)} aria-live="polite">{copied[t.id] ?? 'Copy'}</button>
              <button class="btn" data-testid="vt-qr-{t.name}" disabled={!configured} onclick={() => openQr(t)}>QR code</button>
              <button class="btn" data-testid="vt-validity-{t.name}" onclick={() => (validityOf = { t, days: t.days })}>Validity</button>
              <button class="btn" data-testid="vt-edit-accounts-{t.name}" onclick={() => editAccounts(t)}>Accounts</button>
              <button class="btn danger" data-testid="vt-delete-{t.name}" onclick={() => (deleting = t)}>Delete</button>
            </td>
          </tr>
        {/each}
        {#if !items.length}<tr><td colspan="7" class="muted" data-testid="vt-empty">No tokens.</td></tr>{/if}
      </tbody>
    </table>
  </div>
  <form class="row" onsubmit={add}>
    <label>Name<input data-testid="vt-name" bind:value={name} maxlength="64" placeholder="Kitchen tablet" required /></label>
    <label>Valid for<select data-testid="vt-days" bind:value={days}>{#each VALIDITY as v}<option value={v.days}>{v.label}</option>{/each}</select></label>
    <label>Role<select class="role {roleClass(role)}" data-testid="vt-role" bind:value={role}>{#each ROLES as r}<option value={r.role}>{r.label}</option>{/each}</select></label>
    <fieldset class="row accounts" data-testid="vt-pick">
      <legend>Accounts</legend>
      {#each all as a (a.id)}<label class="check"><input type="checkbox" data-testid="vt-pick-{a.name}" bind:checked={chosen[a.id]} /> {a.name}</label>{/each}
    </fieldset>
    <button class="btn primary" data-testid="vt-add" disabled={!configured}>Add token</button>
  </form>
  {#if role === 'admin'}<p class="badge warn" data-testid="vt-admin-warning">{ADMIN_WARNING}</p>{/if}
  {#if error}<p class="error" data-testid="vt-error">{error}</p>{/if}
</section>

{#if qr}
  <div class="scrim" role="presentation" onclick={() => (qr = null)}></div>
  <div class="dialog card" role="dialog" aria-modal="true" aria-label="Sign-in QR code" data-testid="vt-qr-window">
    <h3>Sign in as “{qr.name}”</h3>
    <svg class="qr" viewBox="0 0 {qr.size} {qr.size}" shape-rendering="crispEdges" role="img" aria-label="QR code of the sign-in link" data-testid="vt-qr-code">
      <rect width={qr.size} height={qr.size} fill="#fff" /><path d={qr.path} fill="#000" />
    </svg>
    <p class="muted">Scan with a phone camera, or open the link: it signs in on <b>{linkHost(qr.link)}</b>. On another viewer of these accounts, paste the token.</p>
    <div class="row end">
      <button class="btn" data-testid="vt-copy-link" onclick={copyLink} aria-live="polite">{copied.qr ?? 'Copy link'}</button>
      <button class="btn primary" data-testid="vt-qr-close" onclick={() => (qr = null)}>Close</button>
    </div>
  </div>
{/if}

{#if validityOf}
  <div class="scrim" role="presentation" onclick={() => (validityOf = null)}></div>
  <div class="dialog card" role="dialog" aria-modal="true" aria-label="Validity" data-testid="vt-validity-window">
    <h3>Validity of “{validityOf.t.name}”</h3>
    <p>Valid from now for the length you pick (longer or shorter). A revoked or expired token becomes valid again, with the same token.</p>
    <label>Valid for<select data-testid="vt-validity-days" bind:value={validityOf.days}>{#each VALIDITY as v}<option value={v.days}>{v.label}</option>{/each}</select></label>
    <div class="row end">
      <button class="btn danger" data-testid="vt-revoke" disabled={validityOf.t.state === 'revoked'} onclick={() => setValidity(true)}>Revoke</button>
      <button class="btn" data-testid="vt-validity-cancel" onclick={() => (validityOf = null)}>Cancel</button>
      <button class="btn primary" data-testid="vt-validity-save" onclick={() => setValidity(false)}>Set</button>
    </div>
  </div>
{/if}

{#if accountsOf}
  <div class="scrim" role="presentation" onclick={() => (accountsOf = null)}></div>
  <div class="dialog card" role="dialog" aria-modal="true" aria-label="Accounts" data-testid="vt-accounts-window">
    <h3>Accounts of “{accountsOf.t.name}”</h3>
    <div class="grid">{#each all as a (a.id)}<label class="check"><input type="checkbox" data-testid="vt-acc-{a.name}" bind:checked={accountsOf.pick[a.id]} /> {a.displayName} <span class="mono muted">{a.name}</span></label>{/each}</div>
    <div class="row end">
      <button class="btn" data-testid="vt-accounts-cancel" onclick={() => (accountsOf = null)}>Cancel</button>
      <button class="btn primary" data-testid="vt-accounts-save" disabled={!Object.values(accountsOf.pick).some(Boolean)} onclick={saveAccounts}>Save</button>
    </div>
  </div>
{/if}

{#if deleting}
  <Confirm title="Delete token {deleting.name}" body="This revokes the token and removes it from the list. People signed in with it are signed out within about a minute." ok="Delete token" onconfirm={remove} oncancel={() => (deleting = null)} />
{/if}

<style>
  h3 { margin: 0; }
  p { margin: 0; }
  form { align-items: end; }
  .actions { gap: 4px; flex-wrap: nowrap; }
  select.role.warn { border-color: var(--warning); color: var(--warning); }
  /* The role pulldown and the buttons are taller than the text cells: centre the row (Klaus 2026-11-08). */
  td { vertical-align: middle; }
  .accounts { border: 1px solid var(--border); border-radius: var(--radius); padding: 2px 8px 6px; gap: 10px; flex-wrap: wrap; }
  .accounts legend { font-size: 12px; color: var(--muted); }
  .check { display: inline-flex; gap: 6px; align-items: center; }
  .scrim { position: fixed; inset: 0; background: var(--scrim); z-index: 10; }
  .dialog { position: fixed; z-index: 11; left: 50%; top: 10%; transform: translateX(-50%); width: min(420px, calc(100vw - 32px)); max-height: 85vh; overflow: auto; box-shadow: var(--shadow); display: grid; gap: 12px; }
  .qr { width: min(280px, 100%); height: auto; justify-self: center; border-radius: 6px; }
  .end { justify-content: flex-end; }
</style>
