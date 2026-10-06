<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import { live } from '../lib/live';
  import { ago, camClass } from '../lib/format';
  import StateChip from '../components/StateChip.svelte';
  import Ago from '../components/Ago.svelte';
  import { clock } from '../lib/clock.svelte';

  let d = $state<any>(null);
  let onlyProblems = $state(false);
  let error = $state('');

  const load = () => api('GET', '/dashboard').then((x) => { d = x; error = ''; }).catch((e) => (error = String(e)));
  onMount(() => {
    load();
    let t: ReturnType<typeof setTimeout> | null = null;
    const soon = () => { if (!t) t = setTimeout(() => { t = null; load(); }, 300); };
    // Status events update rows in place; registry events (and reconnects) reload.
    const stop = live({
      status: (s) => {
        if (!d) return;
        for (const a of d.accounts) {
          const p = a.proxies.find((x: any) => x.id === s.proxyId);
          if (!p) continue;
          Object.assign(p, { state: s.state, ok: s.ok, problemCount: s.problemCount, lastHeartbeatAt: s.lastHeartbeatAt, cameras: s.cameras, stale: false });
          for (const c of a.cameras) if (c.proxyId === p.id) c.online = s.cameras.find((k) => k.ref === c.proxyCameraId)?.online ?? null;
          if (s.state !== 'online' || s.cameras.length !== p.cameras.length) soon();
        }
      },
      registry: soon,
      open: soon,
    });
    return stop;
  });

  const hasProblem = (p: any) => p.state !== 'online' || (p.problemCount ?? 0) > 0 || p.pin === 'mismatch' || p.skewProblem || p.reconcile.reportedNotRegistered.length || p.reconcile.registeredNotReported.length;
  const visible = $derived(d ? d.accounts.filter((a: any) => !onlyProblems || a.proxies.some(hasProblem) || a.warnings.length) : []);
  const counts = $derived.by(() => {
    if (!d) return null;
    const px = d.accounts.flatMap((a: any) => a.proxies);
    const cams = d.accounts.flatMap((a: any) => a.cameras);
    return { accounts: d.accounts.length, proxies: px.length, online: px.filter((p: any) => p.state === 'online').length, cameras: cams.length, camsOnline: cams.filter((c: any) => c.online).length, problems: px.filter(hasProblem).length };
  });
</script>

{#if error}<p class="error">{error}</p>{/if}
{#if d && counts}
  <section class="strip card" data-testid="dash-summary">
    <div><b data-testid="sum-accounts">{counts.accounts}</b> accounts</div>
    <div><b data-testid="sum-proxies">{counts.online}/{counts.proxies}</b> proxies online</div>
    <div><b data-testid="sum-cameras">{counts.camsOnline}/{counts.cameras}</b> cameras online</div>
    <div><b data-testid="sum-problems">{counts.problems}</b> with problems</div>
    <a href="#/backup" class="backup" data-testid="backup-card">
      <span class="chip {d.backup.alerts.length ? 'bad' : 'ok'}">backup</span>
      <span class="muted">snapshot {ago(d.backup.lastSnapshotAt, clock.now)}{d.backup.litestream ? `, replicated ${ago(d.backup.lastReplicationAt, clock.now)}` : ''}</span>
      {#each d.backup.alerts as a}<span class="badge bad">{a}</span>{/each}
    </a>
  </section>
  <label class="row filter"><input type="checkbox" bind:checked={onlyProblems} data-testid="filter-problems" /> Only problems</label>
  {#if d.refusedProxyIds.length}
    <section class="card" data-testid="refused">
      <b>Refused proxy ids</b> <span class="muted">(after a restore these need a new enrollment code)</span>
      {#each d.refusedProxyIds as r}<div class="mono">{r.id}: {r.reason}</div>{/each}
    </section>
  {/if}
  {#each visible as a (a.id)}
    <section class="card account" data-testid="dash-account-{a.name}">
      <div class="row head">
        <a href="#/accounts/{a.id}"><b>{a.displayName}</b></a><span class="muted mono">{a.name}</span>
        {#if a.warnings.includes('no-admin')}<span class="badge warn" data-testid="warn-no-admin-{a.name}">no admin user</span>{/if}
      </div>
      {#if !a.proxies.length}<p class="muted">No proxies yet.</p>{/if}
      {#each a.proxies as p (p.id)}
        <div class="proxy" data-testid="proxy-row-{p.name}">
          <div class="row">
            <a href="#/accounts/{a.id}/proxies/{p.id}" data-testid="proxy-link-{p.name}"><b>{p.displayName}</b></a>
            <StateChip state={p.state} testid="proxy-state-{p.name}" />
            {#if p.stale}<span class="badge" data-testid="stale-{p.name}">stale</span>{/if}
            <span class="muted">heartbeat <Ago t={p.lastHeartbeatAt} testid="proxy-age-{p.name}" /></span>
            {#if p.version}<span class="muted mono hide-phone">{p.version}</span>{/if}
            {#if p.state === 'online' && p.problemCount}<span class="badge bad" data-testid="problems-{p.name}">{p.problemCount} problem{p.problemCount === 1 ? '' : 's'}</span>{/if}
            {#if p.unreadable}<span class="badge bad">{p.unreadable}</span>{/if}
            {#if p.pin === 'mismatch'}<span class="badge bad" data-testid="badge-pin-{p.name}">pin mismatch</span>{/if}
            {#if p.pin === 'hint'}<span class="badge" data-testid="badge-pin-hint-{p.name}">no pin registered</span>{/if}
            {#if p.skewProblem}<span class="badge warn" data-testid="badge-skew-{p.name}">clock off {Math.round(p.skewMs / 1000)} s</span>{/if}
            {#if p.reconcile.reportedNotRegistered.length}<span class="badge warn" data-testid="badge-reported-{p.name}">{p.reconcile.reportedNotRegistered.length} reported, not registered</span>{/if}
            {#if p.reconcile.registeredNotReported.length}<span class="badge warn" data-testid="badge-registered-{p.name}">{p.reconcile.registeredNotReported.length} registered, not reported</span>{/if}
          </div>
          <div class="row cams">
            {#each p.cameras as c (c.ref)}
              {@const reg = a.cameras.find((x: any) => x.proxyId === p.id && x.proxyCameraId === c.ref)}
              <span class="chip {camClass(c.online)}" data-testid="cam-chip-{p.name}-{c.ref}" data-online={String(c.online)}>{reg ? reg.camsId : c.ref}{reg?.kind === 'sim' ? ' (sim)' : ''}</span>
            {/each}
          </div>
        </div>
      {/each}
    </section>
  {/each}
{:else if !error}
  <p class="muted">Loading…</p>
{/if}

<style>
  .strip { display: flex; gap: 20px; flex-wrap: wrap; align-items: center; }
  .backup { display: flex; gap: 8px; align-items: center; margin-left: auto; text-decoration: none; color: inherit; flex-wrap: wrap; }
  .filter { color: var(--text); font-size: 14px; display: flex; }
  .account { display: grid; gap: 10px; }
  .head { gap: 10px; }
  .proxy { border-top: 1px solid var(--border); padding-top: 8px; display: grid; gap: 6px; }
  .cams { gap: 6px; }
</style>
