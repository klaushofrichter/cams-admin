<script lang="ts">
  // Camera moves between two proxies of one account: every move, its phase and progress; the detail has cancel and end transfer.
  import { onMount } from 'svelte';
  import { api, errorText } from '../lib/api';
  import { coalesced, live } from '../lib/live';
  import { cancelable, etaText, phaseClass, phaseText, progressText, reasonText } from '../lib/moves';
  import MoveDetail from '../components/MoveDetail.svelte';

  let items = $state<any[]>([]);
  let loaded = $state(false);
  let error = $state('');
  let open = $state<Record<string, boolean>>({});

  async function load() {
    try {
      items = (await api('GET', '/moves')).items;
      error = '';
    } catch (e) { error = errorText(e); }
    loaded = true;
  }
  onMount(() => {
    load();
    const soon = coalesced(load, 250);
    return live({ registry: (r) => { if (r.type === 'move') soon(); }, open: soon });
  });
  const shown = (m: any) => open[m.id] ?? (cancelable(m.phase) || m.endedAt === null);
</script>

<section class="card grid">
  <h2>Moves</h2>
  <p class="muted">A camera moving from one proxy to another of the same account: its phase and progress, and cancel or end the transfer early.</p>
  {#if error}<p class="error" data-testid="moves-error">{error}</p>{/if}
  <div class="scroll-x">
    <table data-testid="moves-list">
      <thead><tr><th>Camera</th><th>From</th><th>To</th><th>Phase</th><th>Progress</th></tr></thead>
      <tbody>
        {#each items as m (m.id)}
          <tr data-testid="move-row-{m.id}">
            <td><button class="link" data-testid="move-toggle-{m.id}" onclick={() => (open[m.id] = !shown(m))}>{m.cameraName || m.camsId}</button></td>
            <td>{m.source.name}</td>
            <td>{m.target.name}</td>
            <td>
              <span class="chip {phaseClass(m.phase)}" data-testid="move-phase-{m.id}">{phaseText(m.phase)}</span>
              {#if m.reason && (m.phase === 'rejected' || m.phase === 'failed')}<span class="muted small" data-testid="move-reason-{m.id}"> {reasonText(m.reason)}</span>{/if}
              {#if m.budgetExceeded}<span class="badge warn" data-testid="move-budget-{m.id}">Over time budget</span>{/if}
            </td>
            <td>{progressText(m)}{#if m.phase === 'copying' && etaText(m.etaS)}<div class="muted small">{etaText(m.etaS)}</div>{/if}</td>
          </tr>
          {#if shown(m)}
            <tr class="detail"><td colspan="5"><MoveDetail move={m} onchange={load} /></td></tr>
          {/if}
        {/each}
        {#if loaded && !items.length}<tr><td colspan="5" class="muted" data-testid="moves-empty">No camera move yet. Start one from the camera on its proxy, or ask for a move in cams.</td></tr>{/if}
      </tbody>
    </table>
  </div>
</section>

<style>
  h2 { margin: 0; }
  .small { font-size: 12px; }
  .detail td { border-top: 0; padding-top: 0; }
  .link { background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; font: inherit; text-decoration: underline; }
</style>
