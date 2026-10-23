<script lang="ts">
  // One move: chunk counts, the check, the cleanup note, the copy back; Cancel move…, End transfer… (after Archive when it is still copying) and Give up behind typed confirms.
  import { api, errorText } from '../lib/api';
  import { boundsText, canGiveUp, cancelable, checkText, endLabel, reasonText, phaseText } from '../lib/moves';
  import Confirm from './Confirm.svelte';

  let { move, onchange, onopen }: { move: any; onchange: () => void; onopen?: (id: string) => void } = $props();
  let chunks = $state<Record<string, number> | null>(null);
  let error = $state('');
  let dialog = $state<null | 'cancel' | 'end' | 'giveup'>(null);
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
  // After the switch-over (copying) a cancel copies the camera's content back; before it there is a choice for what was copied.
  const copyBack = $derived(move.phase === 'copying');
  const CHUNK_ORDER = ['pending', 'copied', 'verified', 'skipped', 'failed', 'abandoned'];
</script>

<div class="grid detail" data-testid="move-detail-{move.id}">
  <div class="row muted">
    <span>{move.camsId}: {move.source.name} → {move.target.name}</span>
    <span>· {phaseText(move.phase)}{move.reason ? ` (${reasonText(move.reason)})` : ''}</span>
  </div>
  <p class="muted small" data-testid="move-bounds">{boundsText(move.bounds ?? null)}</p>
  {#if chunks && CHUNK_ORDER.some((k) => chunks![k])}
    <div class="row" data-testid="move-chunks-{move.id}">{#each CHUNK_ORDER as k}{#if chunks[k]}<span class="badge">{k}: {chunks[k]}</span>{/if}{/each}</div>
  {/if}
  {#if move.check}<p class="small" data-testid="move-check">Check: {checkText(move.check)}</p>{/if}
  {#if move.returnId || move.returnOf}
    <p class="small">
      {#if move.returnId}Copy back: {:else}Copy back of the cancelled move: {/if}
      <button class="link" data-testid="move-return-link" onclick={() => onopen?.(move.returnId ?? move.returnOf)}>{move.returnId ? 'show the copy back' : 'show the cancelled move'}</button>
    </p>
  {/if}
  {#if move.endRequested}<p class="muted small" data-testid="move-end-waiting">The transfer ends as soon as Archive is copied. Ending it again changes nothing.</p>{/if}
  {#if move.cleanupPending}<p class="muted small" data-testid="move-cleanup-pending">Cleanup on {move.source.name} pending</p>{/if}
  {#if move.targetCleanupPending}<p class="muted small" data-testid="move-target-cleanup-pending">Cleanup on {move.target.name} pending</p>{/if}
  {#if error}<p class="error" data-testid="move-error">{error}</p>{/if}
  {#if cancelable(move.phase)}
    <div class="row">
      <button class="btn danger" data-testid="move-cancel" onclick={() => { copied = 'delete'; dialog = 'cancel'; }}>Cancel move…</button>
      {#if move.phase === 'copying'}<button class="btn" data-testid="move-end-transfer" disabled={move.endRequested} onclick={() => (dialog = 'end')}>{endLabel(move)}</button>{/if}
    </div>
  {/if}
  {#if canGiveUp(move.phase)}
    <div class="row">
      <button class="btn danger" data-testid="move-give-up" onclick={() => (dialog = 'giveup')}>Give up copy back…</button>
    </div>
  {/if}
</div>

{#if dialog === 'cancel' && copyBack}
  <Confirm title="Cancel move" body="The move stops and the camera goes back to {move.source.name}. What was copied and what {move.target.name} recorded since the switch-over is copied back to {move.source.name}." typed="cancel" ok="Cancel move"
    onconfirm={() => run('cancel', { confirm: 'cancel' })} oncancel={() => (dialog = null)} />
{:else if dialog === 'cancel'}
  <Confirm title="Cancel move" body="The move stops. What do you want to do with what was already copied?" typed="cancel" ok="Cancel move"
    onconfirm={() => run('cancel', { copied, confirm: 'cancel' })} oncancel={() => (dialog = null)}>
    <fieldset class="choice">
      <label class="check"><input type="radio" name="copied-{move.id}" value="delete" bind:group={copied} data-testid="move-copied-delete" /> Delete what was copied</label>
      {#if copied === 'delete'}<p class="muted small" data-testid="move-copied-hint">Only content the move copied is deleted; what the target recorded since the switch-over stays and ages out there.</p>{/if}
      <label class="check"><input type="radio" name="copied-{move.id}" value="age-out" bind:group={copied} data-testid="move-copied-age-out" /> Let it age out on the target</label>
    </fieldset>
  </Confirm>
{:else if dialog === 'end'}
  <Confirm title={move.archivePending ? 'End after Archive' : 'End transfer'}
    body={move.archivePending ? 'Archive is still being copied. The transfer ends when it is done; then the rest of the old content stays behind and is deleted with the camera on the old proxy.' : 'The rest of the old content stays behind and is deleted with the camera on the old proxy.'}
    typed="end transfer" ok={move.archivePending ? 'End after Archive' : 'End transfer'}
    onconfirm={() => run('end-transfer', { confirm: 'end transfer' })} oncancel={() => (dialog = null)} />
{:else if dialog === 'giveup'}
  <Confirm title="Give up copy back" body="The copy back stops. Nothing is deleted on either proxy: the content stays where it is and ages out there."
    typed="give up" ok="Give up" onconfirm={() => run('give-up', { confirm: 'give up' })} oncancel={() => (dialog = null)} />
{/if}

<style>
  .small { font-size: 12px; margin: 0; }
  .link { background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; font: inherit; text-decoration: underline; }
  .choice { border: 0; padding: 0; margin: 0; display: grid; gap: 6px; }
  .check { display: flex; flex-direction: row; align-items: center; gap: 6px; color: var(--text); }
</style>
