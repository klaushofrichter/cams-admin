<script lang="ts">
  import { keepEdits } from '../lib/edits';
  import { onMount } from 'svelte';
  import { api, errorText } from '../lib/api';
  import { coalesced, live } from '../lib/live';
  import { camClass } from '../lib/format';
  import { hostLabel } from '../lib/proxy';
  import { nameError, renameError, renameOutcome, waitCommand } from '../lib/config';
  import StateChip from '../components/StateChip.svelte';
  import ProxyGui from '../components/ProxyGui.svelte';
  import Confirm from '../components/Confirm.svelte';
  import DeleteLines from '../components/DeleteLines.svelte';
  import { accountDeleteLines, cameraDeleteLines, type DeleteLines as Lines } from '../lib/deletes';
  import ImportPanel from '../components/ImportPanel.svelte';
  import ViewerTokens from '../components/ViewerTokens.svelte';
  import VisionTab from '../components/VisionTab.svelte';
  import SwitchesTab from '../components/SwitchesTab.svelte';
  import CameraPower from '../components/CameraPower.svelte';
  import RemoveCamera from '../components/RemoveCamera.svelte';
  import { addCameraBody, reportedOf, type ReportedCam } from '../lib/addCamera';

  let { accountId, tab }: { accountId: string; tab: string } = $props();

  const VIEWER_ADDRESS_HINT = 'How cams viewers reach this proxy';

  let account = $state<any>(null);
  let users = $state<any[]>([]);
  let proxies = $state<any[]>([]);
  let cameras = $state<any[]>([]);
  let switches = $state<any[]>([]);
  let others = $state<Record<string, string[]>>({});
  let error = $state('');
  let notFound = $state(false);
  let confirmDelete = $state(false);
  let deleteLines = $state<Lines | null>(null);
  let deletingCamera = $state<any>(null);
  // Remove from proxy (spec 2026-11-08 B4): the camera whose panel is open.
  let removingCamera = $state<any>(null);
  // The Vision tab is for system admins only (the server checks it too).
  let systemAdmin = $state(false);
  const TABS = $derived(['overview', 'users', 'proxies', 'cameras', 'switches', 'sims', 'import', ...(systemAdmin ? ['vision'] : [])]);

  // A cams instance's problems for this account, in words (finding 12b).
  let camsProblems = $state<{ instanceId: string; code: string; text: string }[]>([]);
  // Read on the Overview only (each registry change reloads the page's lists).
  const loadCamsProblems = () => api('GET', `/accounts/${accountId}/cams-problems`).then((r) => (camsProblems = r.items)).catch(() => (camsProblems = []));
  let lastTab = '';
  $effect(() => { if (tab === 'overview' && lastTab !== 'overview' && account) loadCamsProblems(); lastTab = tab; });
  async function load() {
    try {
      account = await api('GET', `/accounts/${accountId}`);
      api('GET', '/me').then((m) => (systemAdmin = m?.systemAdmin === true)).catch(() => (systemAdmin = false));
      api('GET', `/accounts/${accountId}/switches`).then((r) => (switches = r.items)).catch(() => (switches = []));
      if (tab === 'overview') loadCamsProblems();
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
    // A busy fleet sends many registry events (every command's change is one): a burst is one reload a second, not one per event.
    const soon = coalesced(load, 1000);
    return live({ registry: soon, status: (s) => { const p = proxies.find((x) => x.id === s.proxyId); if (p) p.status = { ...p.status, state: s.state, cameras: s.cameras }; } });
  });
  const go = (t: string) => (location.hash = `#/accounts/${accountId}/${t}`);
  const admins = $derived(users.filter((u) => u.role === 'admin' && !u.disabled).length);

  // --- overview ---------------------------------------------------------------------------
  let editDisplay = $state('');
  let editNotes = $state('');
  let editName = $state('');
  let editAutoAdopt = $state(false);
  $effect(() => { if (account) { editDisplay = account.displayName; editNotes = account.notes ?? ''; editName = account.name; editAutoAdopt = account.autoAdopt === true; } });
  async function saveAccount() {
    error = '';
    try { account = await api('PATCH', `/accounts/${accountId}`, { name: editName, displayName: editDisplay, notes: editNotes || null, autoAdopt: editAutoAdopt, version: account.version }); } catch (e) { error = errorText(e); }
  }
  // The Delete dialog names what goes and what stays (counts from the server).
  async function askDeleteAccount() {
    deleteLines = null;
    confirmDelete = true;
    try { deleteLines = accountDeleteLines(await api('GET', `/accounts/${accountId}/delete-preview`)); } catch (e) { confirmDelete = false; error = errorText(e); }
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
  // Host, protocol and TLS name (finding 12b): the chosen proxy's report of the camera fills them; what it lacks is asked for.
  let cHost = $state('');
  let cProtocol = $state('');
  let cTls = $state('');
  let cReported = $state<ReportedCam[] | null>(null);
  $effect(() => {
    const px = cProxy;
    cReported = null;
    if (!px) return;
    let gone = false;
    api('GET', `/accounts/${accountId}/proxies/${px}/status`).then((st) => { if (!gone) cReported = st?.reported?.cameras ?? []; }).catch(() => { if (!gone) cReported = []; });
    return () => { gone = true; };
  });
  const cFrom = $derived(reportedOf(cReported, cProxyCam.trim()));
  async function addCamera(e: Event) {
    e.preventDefault();
    cError = '';
    try {
      await api('POST', `/accounts/${accountId}/cameras`, addCameraBody({ camsId: cCamsId, name: cName, kind: cKind, proxyId: cProxy, proxyCameraId: cProxyCam.trim(), host: cHost, protocol: cProtocol, tlsName: cTls }));
      cCamsId = cName = cProxyCam = cHost = cProtocol = cTls = '';
      await load();
    } catch (err) { cError = errorText(err); }
  }
  async function assign(c: any, proxyId: string) {
    try { await api('PATCH', `/accounts/${accountId}/cameras/${c.id}`, { proxyId: proxyId || null, proxyCameraId: proxyId ? (c.proxyCameraId ?? c.camsId) : null, version: c.version }); await load(); } catch (e) { cError = errorText(e); }
  }
  // The registry fields of one camera (issue #25), version-checked.
  const EDIT_FIELDS = ['name', 'host', 'protocol', 'tlsServername', 'cameraUser', 'webUiUrl', 'webUiNote', 'proxyCameraId'] as const;
  let camEdit = $state<{ cam: any; f: Record<string, string> } | null>(null);
  const editCamera = (c: any) => { cError = ''; camEdit = { cam: c, f: Object.fromEntries(EDIT_FIELDS.map((k) => [k, c[k] ?? ''])) }; };
  // Behind a proxy the camera holds its name (camera name sync design 2026-11-06): a new name is sent to the camera
  // (the proxy's rename command) and the record follows the proxy's next report. Without a proxy it is the record's.
  const mappedCam = (c: any) => !!(c?.proxyId && c?.proxyCameraId);
  let renaming = $state(false);
  let renameDone = $state('');
  async function saveCameraEdit() {
    if (!camEdit) return;
    const { cam, f } = camEdit;
    const patch: Record<string, unknown> = { version: cam.version };
    // Only what changed; an emptied optional field is cleared (null).
    for (const k of EDIT_FIELDS) if ((f[k] ?? '').trim() !== (cam[k] ?? '')) patch[k] = f[k].trim() || null;
    const newName = mappedCam(cam) && 'name' in patch ? String(patch.name ?? '') : null;
    if (newName !== null) delete patch.name;
    if (Object.keys(patch).length === 1 && newName === null) { camEdit = null; return; }
    cError = renameDone = '';
    let otherSaved = false;
    try {
      let cur = cam;
      if (Object.keys(patch).length > 1) {
        cur = await api('PATCH', `/accounts/${accountId}/cameras/${cam.id}`, patch);
        otherSaved = true;
        if (camEdit) camEdit = { cam: cur, f };
      }
      if (newName !== null) {
        renaming = true;
        const base = `/accounts/${accountId}/proxies/${cur.proxyId}`;
        const r = await api('POST', `${base}/cameras/${encodeURIComponent(cur.proxyCameraId)}/name`, { name: newName });
        const row = await waitCommand(() => api('GET', `${base}/commands/${r.commandId}`));
        const text = renameOutcome(row, newName);
        // A rename the camera did not take (or no answer yet) keeps the form open, the typed name in it.
        if (!row || row.state !== 'done') { cError = renameError(otherSaved, text); await load(); return; }
        renameDone = text;
      }
      camEdit = null;
      await load();
    } catch (e: any) {
      cError = renameError(otherSaved, e?.status === 409 && e?.code === 'conflict' ? 'Someone changed this camera meanwhile: cancel, and edit it again.' : errorText(e));
    } finally { renaming = false; }
  }
  async function deleteCamera() {
    const c = deletingCamera;
    deletingCamera = null;
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
    {#if users.length === 0}<p class="badge warn" data-testid="no-admin-warning">This account has no users: nobody can open it in cams with a Google sign-in until a user is added under Users.</p>
    {:else if admins === 0}<p class="badge warn" data-testid="no-admin-warning">This account has no admin user.</p>{/if}
    <nav class="tabs row">
      {#each TABS as t}
        <button class="btn" class:on={tab === t} data-testid="tab-{t}" onclick={() => go(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
      {/each}
    </nav>
    {#if error}<p class="error" data-testid="account-error">{error}</p>{/if}

    {#if tab === 'overview'}
      {#each camsProblems as cp, i (i)}
        <p class="error" data-testid="account-cams-problem" title={cp.code}>{cp.text}</p>
      {/each}
      <div class="grid two">
        <label>Account name (users may type it at login later; cams refers to the id)<input data-testid="account-edit-name" bind:value={editName} /></label>
        <label>Display name<input data-testid="account-edit-display" bind:value={editDisplay} /></label>
        <label class="wide">Notes<textarea rows="3" bind:value={editNotes}></textarea></label>
        <label class="wide"><input type="checkbox" bind:checked={editAutoAdopt} data-testid="account-auto-adopt" /> Add cameras automatically when their proxy reports them ready
          <span class="muted">(never a camera removed from the account or moved away; set only here, signed in)</span></label>
      </div>
      <div class="row">
        <button class="btn primary" data-testid="account-save" onclick={saveAccount}>Save</button>
        <span class="muted">{users.length} users · {proxies.length} proxies · {cameras.length} cameras · <span class="mono">{account.id}</span></span>
        <button class="btn danger right" data-testid="delete-account" onclick={askDeleteAccount}>Delete account</button>
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
      <ViewerTokens {accountId} />
    {:else if tab === 'proxies'}
      <div class="scroll-x">
        <table>
          <thead><tr><th>Proxy</th><th>Host</th><th>State</th><th>Proxy GUI</th><th class="hide-phone" title={VIEWER_ADDRESS_HINT} data-testid="proxy-viewer-head">Viewer address</th></tr></thead>
          <tbody>
            {#each proxies as p (p.id)}
              <tr data-testid="proxy-item-{p.name}">
                <td><a href="#/accounts/{accountId}/proxies/{p.id}" data-testid="proxy-open-{p.name}">{p.displayName}</a> <span class="mono muted">{p.name}</span></td>
                <td data-testid="proxy-item-host-{p.name}">{hostLabel(p.runsOn, p.hostKind)}</td>
                <td><StateChip state={p.status.state} /></td>
                <td><ProxyGui address={p.adminUiUrl} testid="proxy-item-address-{p.name}" /></td>
                <td class="hide-phone" title={VIEWER_ADDRESS_HINT} data-testid="proxy-item-viewer-{p.name}">{#if p.url}<span class="mono">{p.url}</span>{:else}<span class="muted">–</span>{/if}</td>
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
          <thead><tr><th>cams id</th><th>Name</th><th>Kind</th><th>Proxy</th><th class="hide-phone">Proxy id</th><th>Live</th><th>Power</th>{#if tab === 'sims'}<th>Runs on / URLs</th>{/if}<th></th></tr></thead>
          <tbody>
            {#each list as c (c.id)}
              <tr data-testid="camera-row-{c.camsId}">
                <td class="mono">{c.camsId}</td>
                <td>{c.name}</td>
                <td>{c.kind}</td>
                <td><select value={c.proxyId ?? ''} data-testid="camera-proxy-{c.camsId}" onchange={(e) => assign(c, (e.target as HTMLSelectElement).value)}><option value="">— none —</option>{#each proxies as p}<option value={p.id}>{p.name}</option>{/each}</select></td>
                <td class="hide-phone mono">{#if c.proxyId && c.proxyCameraId}<a href="#/accounts/{accountId}/proxies/{c.proxyId}?camera={encodeURIComponent(c.proxyCameraId)}" data-testid="camera-actions-link-{c.camsId}" title="onboarding and camera actions">{c.proxyCameraId}</a>{:else}{c.proxyCameraId ?? ''}{/if}</td>
                <td><span class="chip {camClass(liveOf(c))}" data-testid="camera-live-{c.camsId}">{liveOf(c) === true ? 'online' : liveOf(c) === false ? 'offline' : 'unknown'}</span></td>
                <td>{#if c.kind === 'camera'}<CameraPower camera={c} {switches} canAct={systemAdmin} onchanged={load} />{/if}</td>
                {#if tab === 'sims' && simEdit[c.id]}
                  {@const s = simEdit[c.id]}
                  <td class="simedit">
                    <select bind:value={s.runsOn} data-testid="sim-runs-on-{c.camsId}">{#each ['mac', 'cluster', 'pi', 'pc', 'cloud', 'other'] as k}<option>{k}</option>{/each}</select>
                    <input placeholder="control URL" bind:value={s.controlUrl} data-testid="sim-control-{c.camsId}" />
                    <input placeholder="UI URL" bind:value={s.uiUrl} />
                    <button class="btn" data-testid="sim-save-{c.camsId}" onclick={() => saveSim(c)}>Save</button>
                  </td>
                {/if}
                <td class="row"><button class="btn" data-testid="camera-edit-{c.camsId}" onclick={() => editCamera(c)}>Edit</button>{#if mappedCam(c)}<button class="btn danger" data-testid="camera-remove-{c.camsId}" onclick={() => (removingCamera = c)}>Remove from proxy…</button>{/if}<button class="btn danger" data-testid="camera-delete-{c.camsId}" onclick={() => (deletingCamera = c)}>Delete</button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if camEdit}
        {@const f = camEdit.f}
        <div class="card grid" data-testid="camera-edit-form">
          <b>Camera {camEdit.cam.camsId}</b>
          <p class="muted">The registry's values: what cams shows and how it reaches the camera. A cams instance can override host and camera user for itself (its page, Camera overrides).</p>
          {#if mappedCam(camEdit.cam)}
            <p class="muted" data-testid="camera-edit-name-note">The name is the camera's own: a new one is sent to the camera through its proxy, and cams-admin takes it from the proxy's next report.</p>
          {:else}
            <p class="muted" data-testid="camera-edit-name-note">This camera has no proxy: the name is only cams-admin's record.</p>
          {/if}
          <div class="grid two">
            <label>Name<input bind:value={f.name} maxlength="31" data-testid="camera-edit-name" /></label>
            <label>Host<input class="mono" bind:value={f.host} placeholder="192.0.2.10 or from-proxy" data-testid="camera-edit-host" /></label>
            <label>Protocol<select bind:value={f.protocol} data-testid="camera-edit-protocol"><option value="">—</option><option>https</option><option>http</option></select></label>
            <label>TLS name<input class="mono" bind:value={f.tlsServername} /></label>
            <label>Camera user<input class="mono" bind:value={f.cameraUser} data-testid="camera-edit-user" /></label>
            <label>Proxy's camera id<input class="mono" bind:value={f.proxyCameraId} /></label>
            <label>Web UI URL<input class="mono" bind:value={f.webUiUrl} /></label>
            <label>Web UI note<input bind:value={f.webUiNote} /></label>
          </div>
          {#if f.name.trim() !== camEdit.cam.name && nameError(f.name.trim())}<p class="error small" data-testid="camera-edit-name-error">{nameError(f.name.trim())}</p>{/if}
          <div class="row"><button class="btn primary" data-testid="camera-edit-save" disabled={renaming || (f.name.trim() !== camEdit.cam.name && !!nameError(f.name.trim()))} onclick={saveCameraEdit}>{renaming ? 'Renaming the camera…' : 'Save'}</button><button class="btn" data-testid="camera-edit-cancel" onclick={() => (camEdit = null)}>Cancel</button></div>
        </div>
      {/if}
      <form class="row" onsubmit={addCamera}>
        <label>cams id<input data-testid="camera-cams-id" bind:value={cCamsId} required /></label>
        <label>Name<input data-testid="camera-name" bind:value={cName} maxlength="31" required={!cProxy} /></label>
        <label>Kind<select data-testid="camera-kind" bind:value={cKind}><option>camera</option><option>sim</option></select></label>
        <label>Proxy<select bind:value={cProxy} data-testid="camera-proxy"><option value="">— none —</option>{#each proxies as p}<option value={p.id}>{p.name}</option>{/each}</select></label>
        <label>Proxy's camera id<input bind:value={cProxyCam} placeholder="cam1" data-testid="camera-proxy-cam" /></label>
        {#if cProxy && cProxyCam.trim()}
          <label>Host<input class="mono" bind:value={cHost} placeholder={cFrom.host ?? '192.0.2.10'} required={cFrom.needs.includes('host')} data-testid="camera-host" /></label>
          <label>Protocol<select bind:value={cProtocol} required={cFrom.needs.includes('protocol')} data-testid="camera-protocol">
            <option value="">{cFrom.protocol ? `${cFrom.protocol} (from the proxy)` : '—'}</option><option>https</option><option>http</option>
          </select></label>
          <label>TLS name<input class="mono" bind:value={cTls} placeholder={cFrom.tlsName ?? ''} data-testid="camera-tls" /></label>
        {/if}
        <button class="btn primary" data-testid="camera-add" disabled={!!cName && !!nameError(cName)}>Add camera</button>
      </form>
      {#if cProxy && cProxyCam.trim() && cReported !== null}
        {#if cFrom.needs.length}
          <p class="muted small" data-testid="camera-connection-ask">The proxy doesn't report {cFrom.needs.join(' and ')} for this camera: enter {cFrom.needs.length === 1 ? 'it' : 'them'} (cams needs host and protocol).</p>
        {:else}
          <p class="muted small" data-testid="camera-connection-from-proxy">Host, protocol and TLS name come from the proxy's report ({cFrom.host}, {cFrom.protocol}{cFrom.tlsName ? `, ${cFrom.tlsName}` : ''}) unless you enter others.</p>
        {/if}
      {/if}
      {#if cName && nameError(cName)}<p class="error small" data-testid="camera-name-error">{nameError(cName)}</p>{/if}
      {#if cProxy}<p class="muted small" data-testid="camera-name-placeholder">The camera's own name replaces this when its proxy reports it.</p>{/if}
      {#if renameDone}<p class="mono small" data-testid="camera-rename-result">{renameDone}</p>{/if}
      {#if cError}<p class="error" data-testid="camera-error">{cError}</p>{/if}
    {:else if tab === 'switches'}
      <SwitchesTab {accountId} {proxies} {cameras} canAct={systemAdmin} onchanged={load} />
    {:else if tab === 'import'}
      <ImportPanel accountId={accountId} accountName={account.name} />
    {:else if tab === 'vision' && systemAdmin}
      <VisionTab {accountId} />
    {/if}
  </section>
  {#if confirmDelete}
    <Confirm title="Delete account {account.name}" body="Everything in the account goes and its proxies are disconnected. A restore from backup is the only undo." typed={account.name} ok="Delete account" okDisabled={!deleteLines || !!deleteLines.blocked} onconfirm={deleteAccount} oncancel={() => (confirmDelete = false)}>
      <DeleteLines lines={deleteLines} testid="account-delete-lines" />
    </Confirm>
  {/if}
  {#if removingCamera}
    <RemoveCamera {accountId} camera={removingCamera} onclose={() => (removingCamera = null)} ondone={load}
      ondeleterecord={() => { deletingCamera = removingCamera; removingCamera = null; }} />
  {/if}
  {#if deletingCamera}
    <Confirm title="Delete camera {deletingCamera.camsId}" body="The camera's record leaves the account; cams no longer shows it." ok="Delete camera" onconfirm={deleteCamera} oncancel={() => (deletingCamera = null)}>
      <DeleteLines lines={cameraDeleteLines(mappedCam(deletingCamera))} testid="camera-delete-lines" />
    </Confirm>
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
  .small { font-size: 12px; margin: 0; }
</style>
