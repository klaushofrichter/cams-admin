<script lang="ts">
  import { onMount } from 'svelte';
  import { api, errorText } from '../lib/api';
  import Ago from './Ago.svelte';
  import StateChip from './StateChip.svelte';
  import { codeText, limitProblem, POLL_FOR_MS, POLL_MS, PROVIDER_NAMES, providerRows, saveText, visionState, type VisionItem } from '../lib/vision';

  // The Account page's Vision tab (design 2026-11-05): per proxy and provider the state, the raw values and
  // this month's use; the monthly limit (0 = off) up to the proxy's ceiling. Refresh asks the proxies and
  // returns at once; the page then reads the stored figures every 2 s for up to 30 s.
  let { accountId }: { accountId: string } = $props();

  let items = $state<VisionItem[]>([]);
  let error = $state('');
  let loaded = $state(false);
  let polling = $state(false);
  let note = $state('');
  // Per row (proxyId/provider): the typed limit, and an error of the page's check or of the PUT.
  let typed = $state<Record<string, string>>({});
  let rowError = $state<Record<string, string>>({});
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pollUntil = 0;

  const rk = (proxyId: string, provider: string) => `${proxyId}/${provider}`;
  const fmt = (x: number | null | undefined) => (x == null ? '—' : x.toLocaleString('en-US'));

  async function load() {
    try {
      items = (await api('GET', `/accounts/${accountId}/vision`)).items;
      for (const it of items) for (const { id, p } of providerRows(it)) if (typed[rk(it.proxyId, id)] === undefined && p) typed[rk(it.proxyId, id)] = String(p.monthlyLimit);
      error = '';
    } catch (e) { error = errorText(e); }
    loaded = true;
  }
  const busy = () => items.some((it) => it.refreshing || Object.values(it.saves ?? {}).some((s) => s.state === 'previewing' || s.state === 'applying'));

  function poll() {
    if (timer) clearTimeout(timer);
    pollUntil = Date.now() + POLL_FOR_MS;
    polling = true;
    const step = async () => {
      await load();
      if (Date.now() < pollUntil && busy()) timer = setTimeout(step, POLL_MS);
      else { polling = false; timer = null; }
    };
    timer = setTimeout(step, POLL_MS);
  }

  async function refresh() {
    note = '';
    try {
      const r = await api('POST', `/accounts/${accountId}/vision/refresh`, {});
      note = r.queued.length ? `Asked ${r.queued.length} ${r.queued.length === 1 ? 'proxy' : 'proxies'}.` : 'No proxy to ask (offline, too old, not allowed, or already asked).';
      await load();
      poll();
    } catch (e) { error = errorText(e); }
  }

  async function save(it: VisionItem, provider: string, ceiling: number | null, current: number | null, enabled: boolean) {
    const k = rk(it.proxyId, provider);
    const v = typed[k] ?? '';
    const problem = limitProblem(v, ceiling, current, enabled);
    rowError[k] = problem ?? '';
    if (problem) return;
    try {
      await api('PUT', `/accounts/${accountId}/vision/proxies/${it.proxyId}/providers/${provider}`, { monthlyLimit: Number(v) });
      await load();
      poll();
    } catch (e: any) {
      const msg = e?.body?.field && e.code !== 'invalid' ? `: ${String(e.body.field).replace(/^[^:]*: /, '')}` : '';
      rowError[k] = e?.code === 'invalid' ? errorText(e) : `Refused: ${codeText(e?.code ?? null)}${msg}.`;
    }
  }

  onMount(() => {
    load();
    return () => { if (timer) clearTimeout(timer); };
  });
</script>

<div class="grid" data-testid="vision-tab">
  <div class="row">
    <button class="btn primary" data-testid="vision-refresh" onclick={refresh}>Refresh</button>
    {#if polling}<span class="muted" data-testid="vision-polling">Reading answers…</span>{/if}
    {#if note}<span class="muted" data-testid="vision-note">{note}</span>{/if}
  </div>
  <p class="muted">Each proxy keeps its own Vision key and its ceiling: the most calls a month cams-admin may allow. A limit of 0 switches Vision off. The proxy has the final word on every change.</p>
  {#if error}<p class="error" data-testid="vision-error">{error}</p>{/if}
  {#if loaded && items.length === 0}<p class="muted" data-testid="vision-empty">This account has no enrolled proxies.</p>{/if}
  {#if items.length}
    <div class="scroll-x">
      <table>
        <thead><tr><th>Proxy</th><th>Provider</th><th>State</th><th>This month</th><th>Monthly limit</th></tr></thead>
        <tbody>
          {#each items as it (it.proxyId)}
            {#each providerRows(it) as { id, p } (id)}
              {@const st = visionState(it, p)}
              {@const k = rk(it.proxyId, id)}
              {@const sv = it.saves?.[id]}
              {@const ceiling = p ? p.remoteMaxMonthly : null}
              <tr data-testid="vision-row-{it.name}-{id}">
                <td>
                  <a href="#/accounts/{accountId}/proxies/{it.proxyId}">{it.displayName}</a> <span class="mono muted">{it.name}</span>
                  <div><StateChip state={it.state} /></div>
                  <div class="muted small" data-testid="vision-asof-{it.name}">As of {#if it.fetchedAt}<Ago t={it.fetchedAt} />{:else}never{/if}{#if it.refreshing} · asking…{/if}</div>
                </td>
                <td>{p?.name ?? PROVIDER_NAMES[id] ?? id}</td>
                <td>
                  <span class="chip {st.cls}" data-testid="vision-state-{it.name}-{id}">{st.word}</span>
                  {#if p}
                    <div class="muted small mono" data-testid="vision-raw-{it.name}-{id}">enabled {p.enabled ? 'yes' : 'no'} · limit {fmt(p.monthlyLimit)} · ceiling {fmt(p.remoteMaxMonthly)} · key {p.key}</div>
                    {#if p.remoteMaxMonthly === 0}<div class="muted small" data-testid="vision-no-ceiling-{it.name}-{id}">cams-admin can't switch it on: no ceiling at the proxy</div>{/if}
                    {#if p.lastError}<div class="muted small">Last error <Ago t={p.lastError.at} />: {p.lastError.message}</div>{/if}
                  {/if}
                </td>
                <td>
                  {#if p}
                    <span data-testid="vision-month-{it.name}-{id}">{fmt(p.month.calls)} / {fmt(p.monthlyLimit)}</span>
                    <div class="muted small">today {fmt(p.today.calls)}{p.dailyCap ? ` (cap ${fmt(p.dailyCap)})` : ''}</div>
                    {#if p.cameras.length}
                      <details data-testid="vision-cameras-{it.name}-{id}">
                        <summary class="muted small">Per camera</summary>
                        <table class="inner"><tbody>
                          {#each p.cameras as c (c.id)}<tr><td class="mono">{c.id}</td><td>{fmt(c.month)} this month</td><td>{fmt(c.today)} today</td></tr>{/each}
                        </tbody></table>
                      </details>
                    {/if}
                  {:else}<span class="muted">—</span>{/if}
                </td>
                <td>
                  <div class="row nowrap">
                    <input class="limit" inputmode="numeric" placeholder="0 = off" bind:value={typed[k]} data-testid="vision-limit-{it.name}-{id}" disabled={it.state !== 'online' || it.access !== 'ok'} />
                    <button class="btn" data-testid="vision-save-{it.name}-{id}" disabled={it.state !== 'online' || it.access !== 'ok'} onclick={() => save(it, id, ceiling, p ? p.monthlyLimit : null, p?.enabled ?? false)}>Save</button>
                  </div>
                  <div class="muted small">0 = off{#if ceiling !== null && ceiling > 0}; up to {fmt(ceiling)}{/if}</div>
                  {#if rowError[k]}<div class="error small" data-testid="vision-row-error-{it.name}-{id}">{rowError[k]}</div>
                  {:else if sv}<div class="small" class:error={sv.state === 'failed'} data-testid="vision-save-state-{it.name}-{id}">{saveText(sv)}</div>{/if}
                </td>
              </tr>
            {/each}
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .small { font-size: 12px; }
  .limit { width: 7.5rem; }
  .nowrap { flex-wrap: nowrap; }
  .inner td { border: 0; padding: 2px 8px 2px 0; white-space: nowrap; }
</style>
