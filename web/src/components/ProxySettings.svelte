<script lang="ts">
  // P3: the proxy's settings as it last reported them, editable where the
  // contract and the proxy allow; every change is a dry run first (Review),
  // then an Apply of exactly that dry run. Values are rendered as text.
  import { api, ApiFailure, errorText } from '../lib/api';
  import { commandsText } from '../lib/commands';
  import { when } from '../lib/format';
  import { groupPaths, narrowNote, narrowOk, parseValue, patternOf, stateLine, valueText, waitCommand, type Change, type ConfigView, type Leaf } from '../lib/config';
  import DiffTable from './DiffTable.svelte';

  let { accountId, proxyId, policy, refresh }: { accountId: string; proxyId: string; policy: string; refresh: number } = $props();
  const base = $derived(`/accounts/${accountId}/proxies/${proxyId}`);

  let st = $state<{ view: ConfigView | null; changedOnProxy: boolean; fetching: string | null; allow: string[] } | null>(null);
  let edits = $state<Record<string, string>>({});
  let phase = $state<'edit' | 'busy' | 'review' | 'conflict'>('edit');
  let busyText = $state('');
  let preview = $state<{ id: string; changes: Change[]; unchanged: string[] } | null>(null);
  let conflict = $state<{ path: string; now: string; mine: string }[]>([]);
  let note = $state('');
  let error = $state('');

  async function load() {
    try { st = await api('GET', `${base}/config`); } catch (e) { error = errorText(e); }
  }
  $effect(() => { void refresh; load(); });

  const view = $derived(st?.view ?? null);
  const groups = $derived(view ? groupPaths(view) : []);
  const allowed = $derived(!!st?.allow.includes('config.get'));
  const canWrite = $derived(!!st?.allow.includes('config.set'));

  // The pending edits: parsed, checked against the settable bounds and the narrow rules.
  const pending = $derived.by(() => {
    const out: { path: string; value?: Leaf; error?: string }[] = [];
    if (!view) return out;
    for (const [path, text] of Object.entries(edits)) {
      const cur = view.paths[path];
      const s = view.settable[patternOf(path)];
      if (!cur || !s || text === valueText(cur.v)) continue;
      const r = parseValue(s, text, path);
      if (!r.ok) out.push({ path, error: r.error });
      else if (!narrowOk(path, cur.v, r.value)) out.push({ path, error: narrowNote(path) ?? 'not allowed from cams-admin' });
      else out.push({ path, value: r.value });
    }
    return out;
  });
  const errOf = (path: string) => pending.find((x) => x.path === path)?.error;
  const ready = $derived(pending.length > 0 && pending.length <= 64 && pending.every((x) => !x.error));
  const setOf = () => Object.fromEntries(pending.map((x) => [x.path, x.value as Leaf]));

  const row = (id: string) => () => api('GET', `${base}/commands/${id}`);

  async function reload() {
    error = '';
    try {
      const r = await api('POST', `${base}/config/refresh`, {});
      await waitCommand(row(r.commandId), 15_000);
    } catch (e) { if (!(e instanceof ApiFailure && e.code === 'already_fetching')) error = errorText(e); }
    await load();
  }

  // Wait until the stored view has the revision the proxy reported (after a write or a conflict).
  async function viewAt(revision: string | null) {
    for (let i = 0; i < 40; i++) {
      await load();
      if (st?.view && (revision ? st.view.revision === revision : !st.changedOnProxy)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  function showConflict(current: Record<string, { v?: unknown; s: string }>) {
    const mine = setOf();
    conflict = Object.keys(mine).map((path) => ({ path, now: current[path] ? `${valueText(current[path].v)} (${current[path].s})` : 'unknown', mine: valueText(mine[path]) }));
    phase = 'conflict';
  }

  async function review() {
    error = '';
    note = '';
    phase = 'busy';
    busyText = 'asking the proxy for a dry run…';
    try {
      const r = await api('POST', `${base}/config/preview`, { set: setOf() });
      const done = await waitCommand(row(r.commandId));
      if (!done) { error = 'The proxy did not answer the dry run.'; phase = 'edit'; return; }
      if (done.state === 'done') {
        preview = { id: r.commandId, changes: done.result?.changes ?? [], unchanged: done.result?.unchanged ?? [] };
        phase = 'review';
        return;
      }
      if (done.outcomeCode === 'conflict') {
        await viewAt(done.result?.revision ?? null);
        return showConflict(done.result?.current ?? {});
      }
      error = `${stateLine(done)}${done.result?.paths ? ': ' + done.result.paths.map((x: any) => `${x.path} ${x.code}${x.detail ? ` (${x.detail})` : ''}`).join('; ') : ''}`;
      phase = 'edit';
    } catch (e) { error = errorText(e); phase = 'edit'; }
  }

  async function applyIt() {
    if (!preview) return;
    error = '';
    phase = 'busy';
    busyText = 'applying on the proxy…';
    try {
      const r = await api('POST', `${base}/config/apply`, { previewId: preview.id });
      const done = await waitCommand(row(r.commandId));
      if (done?.state === 'done') {
        edits = {};
        preview = null;
        phase = 'edit';
        note = `applied: ${(done.result?.changes ?? []).length} change(s)`;
        await viewAt(done.result?.revision ?? null);
        return;
      }
      if (done?.outcomeCode === 'conflict') {
        await viewAt(done.result?.revision ?? null);
        return showConflict(done.result?.current ?? {});
      }
      error = done ? stateLine(done) : 'The proxy did not answer.';
      phase = 'review';
    } catch (e) {
      if (e instanceof ApiFailure && e.code === 'preview_stale') {
        // The proxy changed since the dry run: read it now and show what it holds.
        await reload();
        const cur = Object.fromEntries(Object.keys(setOf()).map((p) => [p, st?.view?.paths[p] ?? { s: '?' }]));
        return showConflict(cur as Record<string, { v?: unknown; s: string }>);
      }
      error = errorText(e);
      phase = 'review';
    }
  }

  function discard() {
    edits = {};
    preview = null;
    conflict = [];
    phase = 'edit';
  }
  function edit(path: string, text: string) {
    edits = { ...edits, [path]: text };
    if (phase === 'review') { preview = null; phase = 'edit'; }
  }
</script>

<section class="card grid" data-testid="settings">
  <div class="row"><h3>Settings</h3>{#if view}<span class="muted">read {when(view.fetchedAt)}</span>{/if}</div>
  <p class:muted={policy !== 'allowed'} class="small">{commandsText(policy, st?.allow ?? [])}</p>
  {#if error}<p class="error" data-testid="settings-error">{error}</p>{/if}
  {#if !st}
    <p class="muted">Loading…</p>
  {:else if !allowed && !view}
    <p class="muted" data-testid="settings-not-allowed">Allow config.get on the proxy's own Status card to see its settings here.</p>
  {:else if !view}
    <p class="muted" data-testid="settings-loading">Reading the proxy's settings…</p>
  {:else}
    {#if st.changedOnProxy}
      <div class="row banner" data-testid="settings-changed">
        <span>Changed on the proxy since cams-admin read it.</span>
        <button class="btn" data-testid="settings-reload" onclick={reload} disabled={!allowed}>Reload</button>
      </div>
    {/if}
    {#if view.clampedPaths}<p class="muted">{view.clampedPaths} settings were too many to show.</p>{/if}
    {#if !canWrite}<p class="muted" data-testid="settings-read-only">Read only: the proxy does not allow config.set.</p>{/if}
    {#each groups as g (g.camera ? `cam:${g.camera}` : g.group)}
      <div class="group">
        <h4>{g.camera ? `camera ${g.camera}` : g.group}</h4>
        <div class="scroll-x">
          <table>
            <tbody>
              {#each g.rows as r (r.path)}
                <tr data-testid="settings-row-{r.path}">
                  <td class="mono label" title={r.path}>{r.label}</td>
                  <td class="mono value" data-testid="settings-value-{r.path}">{valueText(r.p.v)}</td>
                  <td>
                    <span class="badge">{r.p.s}</span>
                    {#if r.p.r}<span class="badge warn">{r.p.p ? `waiting for a ${r.p.r === 'process' ? 'new process' : 'restart'}: ${valueText(r.p.n)}` : r.p.r === 'process' ? 'needs a new process' : 'needs a restart'}</span>{/if}
                    {#if r.p.by}<span class="badge" data-testid="settings-by-{r.path}">set by cams-admin ({r.p.by.actor})</span>{/if}
                  </td>
                  <td>
                    {#if r.editable && canWrite}
                      {@const s = view.settable[patternOf(r.path)]}
                      {#if s.type === 'boolean'}
                        <select data-testid="settings-input-{r.path}" value={edits[r.path] ?? valueText(r.p.v)} onchange={(e) => edit(r.path, (e.target as HTMLSelectElement).value)} disabled={phase === 'busy'}>
                          <option value="true">true</option><option value="false">false</option>
                        </select>
                      {:else}
                        <input class="mono" data-testid="settings-input-{r.path}" value={edits[r.path] ?? valueText(r.p.v)} oninput={(e) => edit(r.path, (e.target as HTMLInputElement).value)} disabled={phase === 'busy'} />
                      {/if}
                      {#if errOf(r.path)}<div class="error small" data-testid="settings-input-error-{r.path}">{errOf(r.path)}</div>{/if}
                    {/if}
                    {#if r.why}<div class="muted small" data-testid="settings-why-{r.path}">{r.why}</div>{/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/each}

    {#if phase === 'busy'}
      <p class="muted" data-testid="settings-status">{busyText}</p>
    {:else if phase === 'review' && preview}
      <div class="grid pending" data-testid="settings-review-box">
        <h4>Review: what the proxy would change</h4>
        <DiffTable changes={preview.changes} unchanged={preview.unchanged} />
        <div class="row">
          <button class="btn primary" data-testid="settings-apply" onclick={applyIt}>Apply</button>
          <button class="btn" data-testid="settings-discard" onclick={discard}>Discard</button>
        </div>
      </div>
    {:else if phase === 'conflict'}
      <div class="grid pending" data-testid="conflict">
        <h4>Changed on the proxy since you loaded it</h4>
        <table>
          <thead><tr><th>Setting</th><th>On the proxy now</th><th>Your change</th></tr></thead>
          <tbody>
            {#each conflict as c (c.path)}
              <tr data-testid="conflict-row-{c.path}"><td class="mono">{c.path}</td><td class="mono">{c.now}</td><td class="mono">{c.mine}</td></tr>
            {/each}
          </tbody>
        </table>
        <div class="row">
          <button class="btn primary" data-testid="conflict-mine" onclick={review}>Use mine</button>
          <button class="btn" data-testid="conflict-keep" onclick={discard}>Keep the proxy's</button>
        </div>
      </div>
    {:else if pending.length}
      <div class="row pending">
        <span>{pending.length} pending change{pending.length === 1 ? '' : 's'}</span>
        <button class="btn primary" data-testid="settings-review" onclick={review} disabled={!ready}>Review changes</button>
        <button class="btn" data-testid="settings-discard" onclick={discard}>Discard</button>
      </div>
    {/if}
    {#if note}<p class="muted" data-testid="settings-note">{note}</p>{/if}
  {/if}
</section>

<style>
  h3, h4 { margin: 0; }
  .group { display: grid; gap: 4px; }
  .label { color: var(--muted); }
  .value { max-width: 28ch; overflow-wrap: anywhere; }
  .small { font-size: 12px; }
  .banner { border: 1px solid var(--warning); border-radius: 8px; padding: 6px 10px; }
  .pending { border-top: 1px solid var(--border); padding-top: 8px; }
  input { max-width: 16ch; }
</style>
