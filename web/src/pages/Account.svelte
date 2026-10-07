<script lang="ts">
  import { keepEdits } from '../lib/edits';
  import { onMount } from 'svelte';
  import { api, errorText } from '../lib/api';
  import { live } from '../lib/live';
  import { camClass } from '../lib/format';
  import StateChip from '../components/StateChip.svelte';
  import Confirm from '../components/Confirm.svelte';
  import ImportPanel from '../components/ImportPanel.svelte';

  let { accountId, tab }: { accountId: string; tab: string } = $props();

  let account = $state<any>(null);
  let users = $state<any[]>([]);
  let proxies = $state<any[]>([]);
  let cameras = $state<any[]>([]);
  let others = $state<Record<string, string[]>>({});
  let error = $state('');
  let notFound = $state(false);
  let confirmDelete = $state(false);

  async function load() {
    try {
      account = await api('GET', `/accounts/${accountId}`);
      [users, proxies, cameras] = await Promise.all([
        api('GET', `/accounts/${accountId}/users`).then((r) => r.items),
        api('GET', `/accounts/${accountId}/proxies`).then((r) => r.items),
        api('GET', `/accounts/${accountId}/cameras`).then((r) => r.items),
      ]);
      fillSims();
      // The other accounts each email belongs to.
      const o: Record<string, string[]> = {};
      await Promise.all(users.map(async (u) => {
        const m = (await api('GET', `/users?email=${encodeURIComponent(u.email)}`)).items;
        o[u.email] = m.filter((x: any) => x.accountId !== accountId).map((x: any) => x.accountName);
      }));
      others = o;
    } catch (e: any) {
      if (e?.status === 404) notFound = true;
      else error = errorText(e);
    }
  }
  onMount(() => {
    load();
    return live({ registry: () => load(), status: (s) => { const p = proxies.find((x) => x.id === s.proxyId); if (p) p.status = { ...p.status, state: s.state, cameras: s.cameras }; } });
  });
  const go = (t: string) => (location.hash = `#/accounts/${accountId}/${t}`);
  const admins = $derived(users.filter((u) => u.role === 'admin' && !u.disabled).length);

  // --- overview ---------------------------------------------------------------------------
  let editDisplay = $state('');
  let editNotes = $state('');
  let editName = $state('');
  $effect(() => { if (account) { editDisplay = account.displayName; editNotes = account.notes ?? ''; editName = account.name; } });
  async function saveAccount() {
    error = '';
    try { account = await api('PATCH', `/accounts/${accountId}`, { name: editName, displayName: editDisplay, notes: editNotes || null, version: account.version }); } catch (e) { error = errorText(e); }
  }
  async function deleteAccount() {
    try { await api('DELETE', `/accounts/${accountId}`, { confirmName: account.name }); location.hash = '#/accounts'; } catch (e) { error = errorText(e); confirmDelete = false; }
  }

  // --- users ------------------------------------------------------------------------------
  let uEmail = $state('');
  let uName = $state('');
  let uRole = $state('viewer');
  let uError = $state('');
  async function addUser(e: Event) {
    e.preventDefault();
    uError = '';
    try { await api('POST', `/accounts/${accountId}/users`, { email: uEmail, displayName: uName || null, role: uRole }); uEmail = uName = ''; await load(); } catch (err) { uError = errorText(err); }
  }
  async function patchUser(u: any, patch: object) {
    try { await api('PATCH', `/accounts/${accountId}/users/${u.id}`, { ...patch, version: u.version }); await load(); } catch (e) { uError = errorText(e); }
  }
  async function deleteUser(u: any) {
    try { await api('DELETE', `/accounts/${accountId}/users/${u.id}`); await load(); } catch (e) { uError = errorText(e); }
  }

  // --- proxies ----------------------------------------------------------------------------
  let pName = $state('');
  let pDisplay = $state('');
  let pRunsOn = $state('local-host');
  let pHostKind = $state('');
  let pUrl = $state('');
  let pError = $state('');
  async function addProxy(e: Event) {
    e.preventDefault();
    pError = '';
    try {
      const p = await api('POST', `/accounts/${accountId}/proxies`, { name: pName, displayName: pDisplay || pName, runsOn: pRunsOn, hostKind: pHostKind || null, url: pUrl || null });
      location.hash = `#/accounts/${accountId}/proxies/${p.id}`;
    } catch (err) { pError = errorText(err); }
  }

  // --- cameras ----------------------------------------------------------------------------
  let cCamsId = $state('');
  let cName = $state('');
  let cKind = $state('camera');
  let cProxy = $state('');
  let cProxyCam = $state('');
  let cError = $state('');
  async function addCamera(e: Event) {
    e.preventDefault();
    cError = '';
    try {
      await api('POST', `/accounts/${accountId}/cameras`, { camsId: cCamsId, name: cName, kind: cKind, proxyId: cProxy || null, proxyCameraId: cProxyCam || null });
      cCamsId = cName = cProxyCam = '';
      await load();
    } catch (err) { cError = errorText(err); }
  }
  async function assign(c: any, proxyId: string) {
    try { await api('PATCH', `/accounts/${accountId}/cameras/${c.id}`, { proxyId: proxyId || null, proxyCameraId: proxyId ? (c.proxyCameraId ?? c.camsId) : null, version: c.version }); await load(); } catch (e) { cError = errorText(e); }
  }
  async function deleteCamera(c: any) {
    try { await api('DELETE', `/accounts/${accountId}/cameras/${c.id}`); await load(); } catch (e) { cError = errorText(e); }
  }
  const liveOf = (c: any) => {
    const p = proxies.find((x) => x.id === c.proxyId);
    return p?.status?.cameras?.find((k: any) => k.ref === c.proxyCameraId)?.online ?? null;
  };

  // --- sims -------------------------------------------------------------------------------
  let simEdit = $state<Record<string, { runsOn: string; controlUrl: string; uiUrl: string; image: string }>>({});
  // The edit buffers, filled when the cameras load (never while rendering).
  // What the server said last: a reload keeps a buffer being edited (keepEdits).
  let simSeen: typeof simEdit = {};
  function fillSims() {
    const next: typeof simEdit = {};
    for (const c of cameras) if (c.kind === 'sim') next[c.id] = { runsOn: c.sim?.runsOn ?? 'mac', controlUrl: c.sim?.controlUrl ?? '', uiUrl: c.sim?.uiUrl ?? '', image: c.sim?.image ?? '' };
    simEdit = keepEdits(simEdit, simSeen, next);
    simSeen = next;
  }
  async function saveSim(c: any) {
    const s = simEdit[c.id];
    try { await api('PUT', `/accounts/${accountId}/cameras/${c.id}/sim`, { runsOn: s.runsOn, controlUrl: s.controlUrl || null, uiUrl: s.uiUrl || null, image: s.image || null }); await load(); } catch (e) { cError = errorText(e); }
  }
</script>

{#if notFound}
  <p class="muted" data-testid="account-gone">This account does not exist (any more). <a href="#/accounts">Accounts</a></p>
{:else if account}
  <section class="card grid">
    <div class="row"><a href="#/accounts" class="muted">Accounts</a><span class="muted">/</span><h2 data-testid="account-title">{account.displayName}</h2><span class="mono muted">{account.name}</span></div>
    {#if admins === 0}<p class="badge warn" data-testid="no-admin-warning">This account has no admin user.</p>{/if}
    <nav class="tabs row">
      {#each ['overview', 'users', 'proxies', 'cameras', 'sims', 'import'] as t}
        <button class="btn" class:on={tab === t} data-testid="tab-{t}" onclick={() => go(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
      {/each}
    </nav>
    {#if error}<p class="error" data-testid="account-error">{error}</p>{/if}

    {#if tab === 'overview'}
      <div class="grid two">
        <label>Account name (users may type it at login later; cams refers to the id)<input data-testid="account-edit-name" bind:value={editName} /></label>
        <label>Display name<input data-testid="account-edit-display" bind:value={editDisplay} /></label>
        <label class="wide">Notes<textarea rows="3" bind:value={editNotes}></textarea></label>
      </div>
      <div class="row">
        <button class="btn primary" data-testid="account-save" onclick={saveAccount}>Save</button>
        <span class="muted">{users.length} users · {proxies.length} proxies · {cameras.length} cameras · <span class="mono">{account.id}</span></span>
        <button class="btn danger right" data-testid="delete-account" onclick={() => (confirmDelete = true)}>Delete account</button>
      </div>
    {:else if tab === 'users'}
      <div class="scroll-x">
        <table>
          <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Disabled</th><th class="hide-phone">Also in</th><th></th></tr></thead>
          <tbody>
            {#each users as u (u.id)}
              <tr data-testid="user-row-{u.email}">
                <td class="mono">{u.email}</td>
                <td>{u.displayName ?? ''}</td>
                <td><select value={u.role} data-testid="user-role-{u.email}" onchange={(e) => patchUser(u, { role: (e.target as HTMLSelectElement).value })}><option>admin</option><option>viewer</option></select></td>
                <td><input type="checkbox" checked={u.disabled} onchange={(e) => patchUser(u, { disabled: (e.target as HTMLInputElement).checked })} /></td>
                <td class="hide-phone muted" data-testid="user-others-{u.email}">{(others[u.email] ?? []).join(', ')}</td>
                <td><button class="btn danger" data-testid="user-delete-{u.email}" onclick={() => deleteUser(u)}>Delete</button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <form class="row" onsubmit={addUser}>
        <label>Email<input data-testid="user-email" type="email" bind:value={uEmail} required /></label>
        <label>Name<input bind:value={uName} /></label>
        <label>Role<select data-testid="user-role" bind:value={uRole}><option>viewer</option><option>admin</option></select></label>
        <button class="btn primary" data-testid="user-add">Add user</button>
      </form>
      {#if uError}<p class="error" data-testid="user-error">{uError}</p>{/if}
    {:else if tab === 'proxies'}
      <div class="scroll-x">
        <table>
          <thead><tr><th>Proxy</th><th>Runs on</th><th>State</th><th class="hide-phone">URL</th></tr></thead>
          <tbody>
            {#each proxies as p (p.id)}
              <tr data-testid="proxy-item-{p.name}">
                <td><a href="#/accounts/{accountId}/proxies/{p.id}" data-testid="proxy-open-{p.name}">{p.displayName}</a> <span class="mono muted">{p.name}</span></td>
                <td>{p.runsOn}{p.hostKind ? ` (${p.hostKind})` : ''}</td>
                <td><StateChip state={p.status.state} /></td>
                <td class="hide-phone mono">{p.url ?? ''}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <form class="row" onsubmit={addProxy}>
        <label>Name<input data-testid="proxy-name" bind:value={pName} placeholder="pi" required /></label>
        <label>Display name<input data-testid="proxy-display" bind:value={pDisplay} placeholder="Garage Pi" /></label>
        <label>Runs on<select data-testid="proxy-runs-on" bind:value={pRunsOn}><option>local-host</option><option>cluster</option><option>cloud</option></select></label>
        <label>Host<select bind:value={pHostKind}><option value="">—</option>{#each ['pi', 'mini-pc', 'pc', 'mac', 'vm', 'container', 'other'] as k}<option>{k}</option>{/each}</select></label>
        <label>URL<input bind:value={pUrl} placeholder="https://proxy.example.net" /></label>
        <button class="btn primary" data-testid="proxy-add">Add proxy</button>
      </form>
      {#if pError}<p class="error" data-testid="proxy-error">{pError}</p>{/if}
    {:else if tab === 'cameras' || tab === 'sims'}
      {@const list = tab === 'sims' ? cameras.filter((c) => c.kind === 'sim') : cameras}
      <div class="scroll-x">
        <table>
          <thead><tr><th>cams id</th><th>Name</th><th>Kind</th><th>Proxy</th><th class="hide-phone">Proxy id</th><th>Live</th>{#if tab === 'sims'}<th>Runs on / URLs</th>{/if}<th></th></tr></thead>
          <tbody>
            {#each list as c (c.id)}
              <tr data-testid="camera-row-{c.camsId}">
                <td class="mono">{c.camsId}</td>
                <td>{c.name}</td>
                <td>{c.kind}</td>
                <td><select value={c.proxyId ?? ''} data-testid="camera-proxy-{c.camsId}" onchange={(e) => assign(c, (e.target as HTMLSelectElement).value)}><option value="">— none —</option>{#each proxies as p}<option value={p.id}>{p.name}</option>{/each}</select></td>
                <td class="hide-phone mono">{#if c.proxyId && c.proxyCameraId}<a href="#/accounts/{accountId}/proxies/{c.proxyId}?camera={encodeURIComponent(c.proxyCameraId)}" data-testid="camera-actions-link-{c.camsId}" title="camera actions on the proxy">{c.proxyCameraId}</a>{:else}{c.proxyCameraId ?? ''}{/if}</td>
                <td><span class="chip {camClass(liveOf(c))}" data-testid="camera-live-{c.camsId}">{liveOf(c) === true ? 'online' : liveOf(c) === false ? 'offline' : 'unknown'}</span></td>
                {#if tab === 'sims' && simEdit[c.id]}
                  {@const s = simEdit[c.id]}
                  <td class="simedit">
                    <select bind:value={s.runsOn} data-testid="sim-runs-on-{c.camsId}">{#each ['mac', 'cluster', 'pi', 'pc', 'cloud', 'other'] as k}<option>{k}</option>{/each}</select>
                    <input placeholder="control URL" bind:value={s.controlUrl} data-testid="sim-control-{c.camsId}" />
                    <input placeholder="UI URL" bind:value={s.uiUrl} />
                    <button class="btn" data-testid="sim-save-{c.camsId}" onclick={() => saveSim(c)}>Save</button>
                  </td>
                {/if}
                <td><button class="btn danger" data-testid="camera-delete-{c.camsId}" onclick={() => deleteCamera(c)}>Delete</button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <form class="row" onsubmit={addCamera}>
        <label>cams id<input data-testid="camera-cams-id" bind:value={cCamsId} required /></label>
        <label>Name<input data-testid="camera-name" bind:value={cName} required /></label>
        <label>Kind<select data-testid="camera-kind" bind:value={cKind}><option>camera</option><option>sim</option></select></label>
        <label>Proxy<select bind:value={cProxy}><option value="">— none —</option>{#each proxies as p}<option value={p.id}>{p.name}</option>{/each}</select></label>
        <label>Proxy's camera id<input bind:value={cProxyCam} placeholder="cam1" /></label>
        <button class="btn primary" data-testid="camera-add">Add camera</button>
      </form>
      {#if cError}<p class="error" data-testid="camera-error">{cError}</p>{/if}
    {:else if tab === 'import'}
      <ImportPanel accountId={accountId} accountName={account.name} />
    {/if}
  </section>
  {#if confirmDelete}
    <Confirm title="Delete account {account.name}" body="This deletes its users, proxies, keys, cameras and status, and disconnects its proxies. A restore from backup is the only undo." typed={account.name} ok="Delete account" onconfirm={deleteAccount} oncancel={() => (confirmDelete = false)} />
  {/if}
{:else if error}
  <p class="error">{error}</p>
{/if}

<style>
  h2 { margin: 0; }
  .tabs { gap: 6px; }
  .tabs .btn.on { border-color: var(--accent); }
  .two { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
  .wide { grid-column: 1 / -1; }
  .right { margin-left: auto; }
  form { align-items: end; }
  .simedit { display: flex; gap: 4px; flex-wrap: wrap; }
  .simedit input { width: 11rem; }
</style>
