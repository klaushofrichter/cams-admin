<script lang="ts">
  import { onMount } from 'svelte';
  import { api, errorText } from '../lib/api';
  import { bytes, when } from '../lib/format';
  import Ago from '../components/Ago.svelte';

  let b = $state<any>(null);
  let busy = $state(false);
  let result = $state<any>(null);
  let error = $state('');
  let ended = $state<number | null>(null);
  const load = () => api('GET', '/backup').then((x) => (b = x)).catch((e) => (error = errorText(e)));
  onMount(load);

  async function now() {
    busy = true;
    error = '';
    try { result = await api('POST', '/backup/now', {}); } catch (e) { error = errorText(e); }
    busy = false;
    load();
  }
  async function endSessions() {
    try { ended = (await api('POST', '/sessions/end', {})).ended; } catch (e) { error = errorText(e); }
  }
</script>

<section class="card grid" data-testid="backup-page">
  <h2>Backup</h2>
  {#if b}
    <div class="grid two">
      <div><div class="muted">Store</div><div class="mono" data-testid="backup-store">{b.store}</div></div>
      <div><div class="muted">Last daily snapshot</div><div data-testid="backup-last-snapshot">{when(b.lastSnapshotAt)} (<Ago t={b.lastSnapshotAt} />)</div>{#if b.lastSnapshotError}<div class="error">{b.lastSnapshotError}</div>{/if}</div>
      <div>
        <div class="muted">Last Litestream replication (newest object in S3)</div>
        {#if b.litestream}
          <div data-testid="backup-last-replication">{when(b.lastReplicationAt)}{#if b.lastReplicationAt} (<Ago t={b.lastReplicationAt} />){/if}</div>
          <div class="muted">checked {when(b.lastReplicationCheckAt)}{b.replicationCheckErrors ? `, ${b.replicationCheckErrors} failed check(s) since start` : ''}</div>
          {#if b.lastReplicationError}<div class="error" data-testid="backup-replication-error">S3 check failed: {b.lastReplicationError}</div>{/if}
        {:else}
          <div data-testid="backup-last-replication">Litestream not configured here</div>
        {/if}
      </div>
      {#if b.litestream}
        <div>
          <div class="muted">Litestream errors (since the sidecar started)</div>
          <div data-testid="backup-litestream-errors">sync {b.litestreamSyncErrors ?? '–'}, replica {b.litestreamReplicaErrors ?? '–'}</div>
          {#if b.litestreamMetricsError}<div class="error">metrics: {b.litestreamMetricsError}</div>{/if}
          <div class="muted">A failed upload is not counted by Litestream 0.5.17; the S3 time above shows it.</div>
        </div>
      {/if}
      <div><div class="muted">Alerts</div><div>{#each b.alerts as a}<span class="badge bad" data-testid="backup-alert">{a}</span> {:else}<span class="chip ok">none</span>{/each}</div></div>
    </div>
  {/if}
  <div class="row">
    <button class="btn primary" data-testid="backup-now" disabled={busy} onclick={now}>{busy ? 'Backing up…' : 'Backup now'}</button>
    <span class="muted">Before a major change: uploads Litestream's pending changes and writes a manual snapshot.</span>
  </div>
  {#if error}<p class="error" data-testid="backup-error">{error}</p>{/if}
  {#if result ?? b?.lastManual}
    {@const r = result ?? b.lastManual}
    <div class="card inner" data-testid="backup-result">
      <div class="row"><span class="chip {r.ok ? 'ok' : 'bad'}" data-testid="backup-result-state">{r.ok ? 'done' : 'failed'}</span><span>{when(r.at)}</span></div>
      <div>Litestream: {r.litestream.ok ? r.litestream.status : r.litestream.error}</div>
      <div>Snapshot: {r.snapshot.ok ? `${r.snapshot.key} (${bytes(r.snapshot.bytes)})` : r.snapshot.error}</div>
    </div>
  {/if}
</section>
<section class="card grid">
  <h3>Sessions</h3>
  <div class="row"><button class="btn danger" data-testid="end-sessions" onclick={endSessions}>End all sessions</button><span class="muted">After a restore, or if a session may have leaked. You sign in again too.</span></div>
  {#if ended !== null}<p>{ended} session(s) ended.</p>{/if}
</section>
<style>h2, h3 { margin: 0; } .two { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); } .inner { background: var(--surface-2); }</style>
