<script lang="ts">
  // The account's PoE switches (design 2026-11-07-poe-switches-design.md). Steps that need the switch answer 202;
  // the outcome is read from the switch (`last`) every 2 s, for at most 60 s.
  import { onMount } from 'svelte';
  import { api, ApiFailure, errorText } from '../lib/api';
  import { chainedText, lastText, operatingProxies, passwordHint, poll, removeText, surveyMissText, trunkText } from '../lib/switches';
  import Ago from './Ago.svelte';
  import Confirm from './Confirm.svelte';

  let { accountId, proxies, cameras, canAct, onchanged }: { accountId: string; proxies: any[]; cameras: any[]; canAct: boolean; onchanged: () => void } = $props();

  let items = $state<any[]>([]);
  let error = $state('');
  let results = $state<Record<string, string>>({});
  let busy = $state<Record<string, boolean>>({});
  let hints = $state<Record<string, string>>({});
  const proxyName = (id: string) => proxies.find((p) => p.id === id)?.name ?? id;

  async function load() {
    try { items = (await api('GET', `/accounts/${accountId}/switches`)).items; } catch (e) { error = errorText(e); }
  }
  onMount(load);

  // --- add --------------------------------------------------------------------------------
  let aName = $state('');
  let aHost = $state('');
  let aModel = $state('sscpoe-web');
  let aPorts = $state(8);
  let aOff = $state(10);
  let aProxy = $state('');
  // No silent default (the first proxy may be the cluster's simulator proxy): the only non-cluster proxy, else a choice.
  const opProxies = $derived(operatingProxies(proxies));
  $effect(() => { if (!aProxy && opProxies.preset) aProxy = opProxies.preset; });
  let addHint = $state('');
  let addError = $state('');
  async function add(e: Event) {
    e.preventDefault();
    addError = addHint = '';
    try {
      const proxyId = aProxy;
      const s = await api<any>('POST', `/accounts/${accountId}/switches`, { name: aName, host: aHost, model: aModel, ports: aPorts, offSeconds: aOff, proxyId });
      addHint = `Set the password on ${proxyName(s.proxyId)}'s Proxy settings → PoE switches, then Test.`;
      aName = aHost = '';
      await load();
    } catch (err) { addError = errorText(err); }
  }

  // --- a step that the switch answers later ----------------------------------------------------
  // `send` returns the HTTP answer; a 202 is followed until the switch has no pending step and `last` is new.
  let formError = $state('');
  async function step(s: any, send: () => Promise<any>, onSent?: () => void) {
    formError = '';
    let sent = false;
    busy = { ...busy, [s.id]: true };
    results = { ...results, [s.id]: 'Sent, waiting for the proxy…' };
    error = '';
    try {
      const prev = (await api<any>('GET', `/switches/${s.id}`)).last;
      const r = await send();
      sent = true;
      onSent?.();
      let text = '';
      if (r && r.commandId) {
        const v = await poll(() => api<any>('GET', `/switches/${s.id}`), (x) => x.pending.length === 0 && x.last && x.last.at !== prev?.at);
        text = v ? lastText(v.last) : 'No answer yet: look again in a minute.';
      }
      results = { ...results, [s.id]: text };
    } catch (e) {
      results = { ...results, [s.id]: errorText(e) };
      if (!sent) formError = errorText(e);
    } finally {
      busy = { ...busy, [s.id]: false };
      await load();
      onchanged();
    }
  }
  const test = (s: any) => step(s, () => api('POST', `/switches/${s.id}/test`, {}));

  // --- survey -----------------------------------------------------------------------------
  async function survey(s: any) {
    busy = { ...busy, [s.id]: true };
    results = { ...results, [s.id]: 'Surveying…' };
    try {
      const prev = (await api<any>('GET', `/switches/${s.id}/survey`)).at;
      await api('POST', `/switches/${s.id}/survey`, {});
      const v = await poll(() => api<any>('GET', `/switches/${s.id}/survey`), (x) => x.state === 'done' && x.at !== prev);
      if (!v) results = { ...results, [s.id]: 'No answer yet: look again in a minute.' };
      else {
        const found = v.results.filter((r: any) => r.found).length;
        const missing = v.results.filter((r: any) => !r.found).map(surveyMissText);
        const trunks = (v.trunks ?? []).map((t: any) => `port ${t.port}: ${t.cameras.map((c: any) => c.camsId).join(', ')}`);
        results = { ...results, [s.id]: `Survey: ${found} found${missing.length ? `; not found: ${missing.join(', ')}` : ''}${trunks.length ? `; not mapped (another switch chained on ${trunks.join('; ')})` : ''}` };
      }
    } catch (e) { results = { ...results, [s.id]: errorText(e) }; } finally {
      busy = { ...busy, [s.id]: false };
      await load();
      onchanged();
    }
  }

  // --- ports ------------------------------------------------------------------------------
  let reads = $state<Record<string, any>>({});
  let openPorts = $state<Record<string, boolean>>({});
  async function togglePorts(s: any) {
    openPorts = { ...openPorts, [s.id]: !openPorts[s.id] };
    if (openPorts[s.id]) await readPorts(s);
  }
  async function readPorts(s: any) {
    results = { ...results, [s.id]: 'Reading the ports…' };
    try {
      const r = await api<any>('POST', `/switches/${s.id}/read`, {});
      reads = { ...reads, [s.id]: r };
      results = { ...results, [s.id]: r.live ? '' : 'The switch did not answer: the table shows what the cameras say.' };
    } catch (e) { results = { ...results, [s.id]: errorText(e) }; }
  }
  const trunkAt = (s: any, port: number) => (s.problems ?? []).find((p: any) => p.code === 'chained_switch' && p.port === port) ?? null;
  const camerasAt = (s: any, port: number) => cameras.filter((c) => c.power && 'switchId' in c.power && c.power.switchId === s.id && c.power.port === port);
  const liveAt = (s: any, port: number) => reads[s.id]?.ports?.find((p: any) => p.port === port)?.live ?? null;
  const mappedNames = (s: any) => cameras.filter((c) => c.power && 'switchId' in c.power && c.power.switchId === s.id).map((c) => c.name);

  // --- edit -------------------------------------------------------------------------------
  let edit = $state<{ s: any; f: { name: string; host: string; ports: number; offSeconds: number; survey: boolean } } | null>(null);
  const startEdit = (s: any) => { formError = ''; edit = { s, f: { name: s.name, host: s.host, ports: s.ports, offSeconds: s.offSeconds, survey: s.survey } }; };
  async function saveEdit() {
    if (!edit) return;
    const { s, f } = edit;
    const patch: Record<string, unknown> = {};
    for (const k of ['name', 'host', 'ports', 'offSeconds', 'survey'] as const) if (f[k] !== s[k]) patch[k] = f[k];
    if (!Object.keys(patch).length) { edit = null; return; }
    await step(s, () => api('PATCH', `/switches/${s.id}`, patch), () => {
      edit = null;
      if ('host' in patch) hints = { ...hints, [s.id]: passwordHint(proxyName(s.proxyId)) };
    });
  }

  // --- move -------------------------------------------------------------------------------
  let move = $state<{ s: any; proxyId: string; host: string } | null>(null);
  async function doMove() {
    if (!move) return;
    const { s, proxyId, host } = move;
    await step(s, () => api('POST', `/switches/${s.id}/move`, { proxyId, ...(host.trim() ? { host: host.trim() } : {}) }), () => {
      move = null;
      hints = { ...hints, [s.id]: passwordHint(proxyName(proxyId)) };
    });
  }

  // --- remove -----------------------------------------------------------------------------
  let removing = $state<any>(null);
  async function doRemove() {
    const s = removing;
    removing = null;
    busy = { ...busy, [s.id]: true };
    results = { ...results, [s.id]: 'Removing: switching PoE back on…' };
    try {
      await api('DELETE', `/switches/${s.id}`);
      const gone = await poll(() => api<any>('GET', `/switches/${s.id}`).then(() => false, (e) => (e instanceof ApiFailure && e.status === 404 ? true : Promise.reject(e))), (x) => x);
      if (!gone) results = { ...results, [s.id]: 'Not removed yet: look again in a minute.' };
    } catch (e) { results = { ...results, [s.id]: errorText(e) }; } finally {
      busy = { ...busy, [s.id]: false };
      await load();
      onchanged();
    }
  }
</script>

<div class="grid" data-testid="switches-tab">
  <p class="muted small">PoE switches tell which port powers which camera, and let a camera be power-cycled safely. The switch password is kept on the proxy that operates the switch.</p>
  {#if error}<p class="error" data-testid="switches-error">{error}</p>{/if}
  <div class="scroll-x">
    <table>
      <thead><tr><th>Name</th><th>Model</th><th>Address</th><th>Proxy</th><th>State</th><th>Serial</th><th>Last read</th><th></th></tr></thead>
      <tbody>
        {#each items as s (s.id)}
          <tr data-testid="switch-row-{s.name}">
            <td>{s.name}{#if s.problems?.length} <span class="badge warn" data-testid="switch-config-{s.name}" title={s.problems.map(chainedText).join(' ')}>configuration issue</span>{/if}</td>
            <td class="mono">{s.model}</td>
            <td class="mono">{s.host}</td>
            <td>{proxyName(s.proxyId)}</td>
            <td data-testid="switch-state-{s.name}">{s.state}</td>
            <td class="mono" data-testid="switch-sn-{s.name}">{s.sn ?? ''}</td>
            <td>{#if s.readAt}<Ago t={s.readAt} />{:else}<span class="muted">never</span>{/if}</td>
            <td class="row wrap">
              <button class="btn" data-testid="switch-ports-{s.name}" onclick={() => togglePorts(s)}>Ports</button>
              {#if canAct}
                <button class="btn" data-testid="switch-test-{s.name}" disabled={busy[s.id]} onclick={() => test(s)}>Test</button>
                <button class="btn" data-testid="switch-survey-{s.name}" disabled={busy[s.id] || s.state !== 'active'} title={s.state === 'active' ? '' : 'Test the switch first'} onclick={() => survey(s)}>Survey now</button>
                <button class="btn" data-testid="switch-edit-{s.name}" disabled={busy[s.id]} onclick={() => startEdit(s)}>Edit</button>
                <button class="btn" data-testid="switch-move-{s.name}" disabled={busy[s.id]} onclick={() => { formError = ''; move = { s, proxyId: s.proxyId, host: '' }; }}>Move</button>
                <button class="btn danger" data-testid="switch-remove-{s.name}" disabled={busy[s.id]} onclick={() => (removing = s)}>Remove</button>
              {/if}
            </td>
          </tr>
          {#each s.problems ?? [] as pr (pr.port)}
            <tr><td colspan="8" class="small"><div class="warn-text" data-testid="switch-problem-{s.name}-{pr.port}">{chainedText(pr)}</div></td></tr>
          {/each}
          {#if results[s.id] || hints[s.id] || s.last}
            <tr><td colspan="8" class="small">
              {#if results[s.id]}<div class="mono" data-testid="switch-result-{s.name}">{results[s.id]}</div>
              {:else if s.last}<div class="mono muted" data-testid="switch-last-{s.name}">{lastText(s.last)}</div>{/if}
              {#if hints[s.id]}<div class="muted" data-testid="switch-hint-{s.name}">{hints[s.id]}</div>{/if}
            </td></tr>
          {/if}
          {#if openPorts[s.id]}
            <tr><td colspan="8">
              <table class="ports" data-testid="switch-port-table-{s.name}">
                <thead><tr><th>Port</th><th>Camera</th><th>PoE</th><th>Watts</th><th>Link</th></tr></thead>
                <tbody>
                  {#each Array.from({ length: s.ports }, (_, i) => i + 1) as n}
                    {@const cams = camerasAt(s, n)}
                    {@const live = liveAt(s, n)}
                    {@const trunk = trunkAt(s, n)}
                    <tr data-testid="switch-port-{s.name}-{n}">
                      <td>{n}</td>
                      <td data-testid="switch-port-camera-{s.name}-{n}">{#if trunk}<span class="badge warn" data-testid="switch-port-trunk-{s.name}-{n}" title={chainedText(trunk)}>{trunkText(trunk.cameras)}</span>{' '}{/if}{#each cams as c, i}{i ? ', ' : ''}{c.name}{#if c.power.notSeen} <span class="muted">(not seen in the last survey)</span>{/if}{/each}</td>
                      <td>{live ? (live.poe ? 'on' : 'off') : cams.length ? (cams[0].power.kind === 'poe' ? 'on' : 'data only') : '–'}</td>
                      <td>{live && typeof live.watts === 'number' ? live.watts : cams[0]?.power.watts ?? '–'}</td>
                      <td>{live ? (live.link === true ? 'up' : live.link === false ? 'down' : '–') : '–'}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </td></tr>
          {/if}
        {:else}
          <tr><td colspan="8" class="muted">No PoE switch yet.</td></tr>
        {/each}
      </tbody>
    </table>
  </div>

  {#if edit}
    {@const f = edit.f}
    <div class="card grid" data-testid="switch-edit-form">
      <b>Edit {edit.s.name}</b>
      <div class="row">
        <label>Name<input data-testid="switch-edit-name" bind:value={f.name} /></label>
        <label>Address<input class="mono" data-testid="switch-edit-host" bind:value={f.host} /></label>
        <label>Ports<input type="number" min="1" max="64" bind:value={f.ports} /></label>
        <label>Off seconds<input type="number" min="1" max="120" bind:value={f.offSeconds} /></label>
        <label><input type="checkbox" bind:checked={f.survey} /> Survey daily</label>
      </div>
      {#if f.host !== edit.s.host}<p class="muted small" data-testid="switch-edit-hint">{passwordHint(proxyName(edit.s.proxyId))} The new address is tested first.</p>{/if}
      {#if formError}<p class="error" data-testid="switch-edit-error">{formError}</p>{/if}
      <div class="row"><button class="btn primary" data-testid="switch-edit-save" onclick={saveEdit}>Save</button><button class="btn" onclick={() => (edit = null)}>Cancel</button></div>
    </div>
  {/if}

  {#if move}
    <div class="card grid" data-testid="switch-move-form">
      <b>Move {move.s.name} to another proxy</b>
      <div class="row">
        <label>Proxy<select data-testid="switch-move-proxy" bind:value={move.proxyId}>{#each proxies as p}<option value={p.id}>{p.name}</option>{/each}</select></label>
        <label>New address (optional)<input class="mono" data-testid="switch-move-host" bind:value={move.host} /></label>
      </div>
      <p class="muted small" data-testid="switch-move-hint">{passwordHint(proxyName(move.proxyId))}</p>
      {#if formError}<p class="error" data-testid="switch-move-error">{formError}</p>{/if}
      <div class="row"><button class="btn primary" data-testid="switch-move-go" onclick={doMove}>Move</button><button class="btn" onclick={() => (move = null)}>Cancel</button></div>
    </div>
  {/if}

  {#if canAct}
    <form class="row" onsubmit={add}>
      <label>Name<input data-testid="switch-name" bind:value={aName} maxlength="60" required /></label>
      <label>Address<input class="mono" data-testid="switch-host" bind:value={aHost} placeholder="192.0.2.20" required /></label>
      <label>Model<select data-testid="switch-model" bind:value={aModel}><option>sscpoe-web</option></select></label>
      <label>Ports<input type="number" min="1" max="64" bind:value={aPorts} /></label>
      <label>Off seconds<input type="number" min="1" max="120" bind:value={aOff} /></label>
      <label>Operating proxy<select data-testid="switch-proxy" bind:value={aProxy} required><option value="" disabled>Choose the proxy on the switch's network</option>{#each opProxies.list as p}<option value={p.id}>{p.name}{p.runsOn === 'cluster' ? ' (cluster)' : ''}</option>{/each}</select></label>
      <button class="btn primary" data-testid="switch-add" disabled={!proxies.length}>Add switch</button>
    </form>
    {#if addError}<p class="error" data-testid="switch-add-error">{addError}</p>{/if}
    {#if addHint}<p class="muted" data-testid="switch-add-hint">{addHint}</p>{/if}
  {/if}
</div>

{#if removing}
  <Confirm title="Remove switch {removing.name}" body={removeText(removing.name, mappedNames(removing))} ok="Remove switch" onconfirm={doRemove} oncancel={() => (removing = null)} />
{/if}

<style>
  .warn-text { color: var(--warning); }
  .wrap { flex-wrap: wrap; gap: 4px; }
  .small { font-size: 12px; margin: 0; }
  form { align-items: end; }
  .ports { width: 100%; }
</style>
