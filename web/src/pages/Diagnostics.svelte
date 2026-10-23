<script lang="ts">
  // Read-only diagnostics tokens (issue #45): issue one for a tool on the
  // sysadmin's machine, see it once, revoke it. The token opens only the GET
  // routes under /api/v1/diag. Operations tokens below do the same for a few
  // write routes, limited to the scopes ticked at issue.
  import { onMount } from 'svelte';
  import { api, errorText } from '../lib/api';
  import { when } from '../lib/format';
  import ShownOnce from '../components/ShownOnce.svelte';

  const SAVE = 'mkdir -p ~/.config/cams-admin && (umask 077; pbpaste > ~/.config/cams-admin/diag-token)';
  let items = $state<any[]>([]);
  let error = $state('');
  let name = $state('mac');
  let days = $state(90);
  let shown = $state<string | null>(null);
  let busy = $state(false);

  const SCOPES = [
    { id: 'tokens', text: 'Proxy tokens: revoke, retire, apply' },
    { id: 'routes', text: 'Cams routes and camera overrides' },
    { id: 'moves', text: 'Camera moves: cancel, end transfer' },
  ];
  const OPS_SAVE = 'mkdir -p ~/.config/cams-admin && (umask 077; pbpaste > ~/.config/cams-admin/ops-token)';
  let opsItems = $state<any[]>([]);
  let opsName = $state('script');
  let opsDays = $state(30);
  let opsScopes = $state<string[]>([]);
  let opsShown = $state<string | null>(null);
  let opsBusy = $state(false);

  async function load() {
    try {
      items = (await api('GET', '/diag-tokens')).items;
      opsItems = (await api('GET', '/ops-tokens')).items;
      error = '';
    } catch (e) { error = errorText(e); }
  }
  onMount(load);

  async function issue() {
    busy = true;
    try {
      shown = (await api('POST', '/diag-tokens', { name, days: Number(days) })).token;
      await load();
    } catch (e) { error = errorText(e); }
    busy = false;
  }
  async function revoke(id: string) {
    try {
      await api('POST', `/diag-tokens/${id}/revoke`);
      await load();
    } catch (e) { error = errorText(e); }
  }
  async function issueOps() {
    opsBusy = true;
    try {
      opsShown = (await api('POST', '/ops-tokens', { name: opsName, days: Number(opsDays), scopes: opsScopes })).token;
      opsScopes = [];
      await load();
    } catch (e) { error = errorText(e); }
    opsBusy = false;
  }
  async function revokeOps(id: string) {
    try {
      await api('POST', `/ops-tokens/${id}/revoke`);
      await load();
    } catch (e) { error = errorText(e); }
  }
</script>

<section class="card grid">
  <h2>Diagnostics</h2>
  <p class="muted">
    A diagnostics token lets a tool read cams-admin's state without a sign-in: proxies, cams instances and their problems, cameras, moves,
    the move precheck and the audit log, at <code>/api/v1/diag/…</code>. It reads only; it never opens another route or a write, and no answer carries a secret.
  </p>
  {#if error}<p class="error" data-testid="diag-error">{error}</p>{/if}
  <form class="row" onsubmit={(e) => { e.preventDefault(); issue(); }}>
    <label>Name <input bind:value={name} maxlength="64" data-testid="diag-name" /></label>
    <label>Days <input type="number" min="1" max="365" bind:value={days} data-testid="diag-days" /></label>
    <button class="btn primary" disabled={busy || !name.trim()} data-testid="diag-issue">Issue token</button>
  </form>
  <div class="scroll-x">
    <table data-testid="diag-tokens">
      <thead><tr><th>Name</th><th>Hash</th><th>Created</th><th>Expires</th><th>Last used</th><th>State</th><th></th></tr></thead>
      <tbody>
        {#each items as t (t.id)}
          <tr data-testid="diag-row-{t.name}">
            <td>{t.name}</td>
            <td class="mono">{t.hashPrefix}</td>
            <td>{when(t.createdAt)}<div class="muted small">{t.createdBy}</div></td>
            <td>{when(t.expiresAt)}</td>
            <td>{t.lastUsedAt ? when(t.lastUsedAt) : '—'}</td>
            <td><span class="chip {t.state === 'active' ? 'ok' : ''}" data-testid="diag-state-{t.name}">{t.state}</span></td>
            <td>{#if t.state === 'active'}<button class="btn" data-testid="diag-revoke-{t.name}" onclick={() => revoke(t.id)}>Revoke</button>{/if}</td>
          </tr>
        {/each}
        {#if !items.length}<tr><td colspan="7" class="muted" data-testid="diag-empty">No diagnostics token yet.</td></tr>{/if}
      </tbody>
    </table>
  </div>
  <p class="muted small">Last used: since cams-admin last started (kept in memory, not in the database).</p>
</section>

<section class="card grid">
  <h2>Operations tokens</h2>
  <p class="muted">
    An operations token lets a script make a few writes without a sign-in: revoke, retire or apply proxy tokens, set or delete cams routes and
    camera overrides, cancel a move or end its transfer, each only if its scope was ticked at issue. It never reads (reads use the diagnostics
    token), and it never issues tokens, codes or passwords. At most 5 are live; 60 writes a minute each.
  </p>
  <form class="grid" onsubmit={(e) => { e.preventDefault(); issueOps(); }}>
    <div class="row">
      <label>Name <input bind:value={opsName} maxlength="64" data-testid="ops-name" /></label>
      <label>Days <input type="number" min="1" max="90" bind:value={opsDays} data-testid="ops-days" /></label>
    </div>
    <div class="row">
      {#each SCOPES as sc (sc.id)}
        <label><input type="checkbox" bind:group={opsScopes} value={sc.id} data-testid="ops-scope-{sc.id}" /> <code>{sc.id}</code> {sc.text}</label>
      {/each}
    </div>
    <div><button class="btn primary" disabled={opsBusy || !opsName.trim() || !opsScopes.length} data-testid="ops-issue">Issue token</button></div>
  </form>
  <div class="scroll-x">
    <table data-testid="ops-tokens">
      <thead><tr><th>Name</th><th>Scopes</th><th>Hash</th><th>Created</th><th>Expires</th><th>Last used</th><th>State</th><th></th></tr></thead>
      <tbody>
        {#each opsItems as t (t.id)}
          <tr data-testid="ops-row-{t.name}">
            <td>{t.name}</td>
            <td>{t.scopes.join(', ')}</td>
            <td class="mono">{t.hashPrefix}</td>
            <td>{when(t.createdAt)}<div class="muted small">{t.createdBy}</div></td>
            <td>{when(t.expiresAt)}</td>
            <td>{t.lastUsedAt ? when(t.lastUsedAt) : '—'}</td>
            <td><span class="chip {t.state === 'active' ? 'ok' : ''}" data-testid="ops-state-{t.name}">{t.state}</span></td>
            <td>{#if t.state === 'active'}<button class="btn" data-testid="ops-revoke-{t.name}" onclick={() => revokeOps(t.id)}>Revoke</button>{/if}</td>
          </tr>
        {/each}
        {#if !opsItems.length}<tr><td colspan="8" class="muted" data-testid="ops-empty">No operations token yet.</td></tr>{/if}
      </tbody>
    </table>
  </div>
</section>

{#if shown}
  <ShownOnce token={shown} title="New diagnostics token" onclose={() => (shown = null)}>
    <p>
      This is the only time cams-admin shows this token. On the Mac: press Copy, then run in a terminal
    </p>
    <pre class="mono" data-testid="diag-save">{SAVE}</pre>
    <p class="muted">The file is readable by you only (mode 600). If the token is lost or leaked, revoke it here and issue a new one.</p>
  </ShownOnce>
{/if}

{#if opsShown}
  <ShownOnce token={opsShown} title="New operations token" onclose={() => (opsShown = null)}>
    <p>
      This is the only time cams-admin shows this token. On the Mac: press Copy, then run in a terminal
    </p>
    <pre class="mono" data-testid="ops-save">{OPS_SAVE}</pre>
    <p class="muted">The file is readable by you only (mode 600). If the token is lost or leaked, revoke it here and issue a new one.</p>
  </ShownOnce>
{/if}

<style>
  h2, p { margin: 0; }
  .small { font-size: 12px; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-all; background: var(--chrome); padding: 8px; border-radius: 6px; }
  input[type='number'] { width: 6em; }
</style>
