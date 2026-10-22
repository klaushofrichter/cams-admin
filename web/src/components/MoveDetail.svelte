<script lang="ts">
  // One move: chunk counts, the cleanup note, Cancel move… and End transfer… behind typed confirms.
  import { api, errorText } from '../lib/api';
  import { cancelable, reasonText, phaseText } from '../lib/moves';
  import Confirm from './Confirm.svelte';

  let { move, onchange }: { move: any; onchange: () => void } = $props();
  let chunks = $state<Record<string, number> | null>(null);
  let error = $state('');
  let dialog = $state<null | 'cancel' | 'end'>(null);
  let copied = $state<'delete' | 'age-out'>('delete');

  $effect(() => {
    void move.updatedAt;
    api('GET', `/moves/${move.id}`).then((r) => (chunks = r.chunks)).catch((e) => (error = errorText(e)));
  });

  async function run(path: string, body: object) {
    error = '';
    dialog = null;
    try { await api('POST', `/moves/${move.id}/${path}`, body); onchange(); } catch (e) { error = errorText(e); }
  }
  const CHUNK_ORDER = ['pending', 'copied', 'verified', 'skipped', 'failed', 'abandoned'];
</script>

<div class="grid detail" data-testid="move-detail-{move.id}">
  <div class="row muted">
    <span>{move.camsId}: {move.source.name} → {move.target.name}</span>
    <span>· {phaseText(move.phase)}{move.reason ? ` (${reasonText(move.reason)})` : ''}</span>
  </div>
  {#if chunks && CHUNK_ORDER.some((k) => chunks![k])}
    <div class="row" data-testid="move-chunks-{move.id}">{#each CHUNK_ORDER as k}{#if chunks[k]}<span class="badge">{k}: {chunks[k]}</span>{/if}{/each}</div>
  {/if}
  {#if move.cleanupPending}<p class="muted small" data-testid="move-cleanup-pending">Cleanup on {move.source.name} pending</p>{/if}
  {#if move.targetCleanupPending}<p class="muted small" data-testid="move-target-cleanup-pending">Cleanup on {move.target.name} pending</p>{/if}
  {#if error}<p class="error" data-testid="move-error">{error}</p>{/if}
  {#if cancelable(move.phase)}
    <div class="row">
      <button class="btn danger" data-testid="move-cancel" onclick={() => { copied = 'delete'; dialog = 'cancel'; }}>Cancel move…</button>
      {#if move.phase === 'copying'}<button class="btn" data-testid="move-end-transfer" onclick={() => (dialog = 'end')}>End transfer…</button>{/if}
    </div>
  {/if}
</div>

{#if dialog === 'cancel'}
  <Confirm title="Cancel move" body="The move stops. What do you want to do with what was already copied?" typed="cancel" ok="Cancel move"
    onconfirm={() => run('cancel', { copied, confirm: 'cancel' })} oncancel={() => (dialog = null)}>
    <fieldset class="choice">
      <label class="check"><input type="radio" name="copied-{move.id}" value="delete" bind:group={copied} data-testid="move-copied-delete" /> Delete what was copied</label>
      {#if copied === 'delete'}<p class="muted small" data-testid="move-copied-hint">Only content the move copied is deleted; what the target recorded since the switch-over stays and ages out there.</p>{/if}
      <label class="check"><input type="radio" name="copied-{move.id}" value="age-out" bind:group={copied} data-testid="move-copied-age-out" /> Let it age out on the target</label>
    </fieldset>
  </Confirm>
{:else if dialog === 'end'}
  <Confirm title="End transfer" body="The rest of the old content stays behind and is deleted with the camera on the old proxy." typed="end transfer" ok="End transfer"
    onconfirm={() => run('end-transfer', { confirm: 'end transfer' })} oncancel={() => (dialog = null)} />
{/if}

<style>
  .small { font-size: 12px; margin: 0; }
  .choice { border: 0; padding: 0; margin: 0; display: grid; gap: 6px; }
  .check { display: flex; flex-direction: row; align-items: center; gap: 6px; color: var(--text); }
</style>
