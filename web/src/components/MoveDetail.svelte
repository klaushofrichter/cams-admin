<script lang="ts">
  // One move: who refused it and why (a rejected move, with Delete), the content checklist, chunk counts, the check, the cleanup note, the copy back;
  // Cancel move…, End transfer… (after Archive when it is still copying) and Give up behind typed confirms. Delete (a rejected record, it holds no content) behind a plain Delete / Keep confirm.
  import { api, errorText } from '../lib/api';
  import { boundsText, canDelete, canGiveUp, cancelable, checkText, contentBasisText, contentLine, endLabel, phaseReason, phaseText, refusalReason, refusedByText, type ContentKind } from '../lib/moves';
  import Confirm from './Confirm.svelte';
  import { spaceText } from '../lib/profile';

  let { move, onchange, onopen }: { move: any; onchange: () => void; onopen?: (id: string) => void } = $props();
  let chunks = $state<Record<string, number> | null>(null);
  let content = $state<{ basis: string | null; kinds: ContentKind[] } | null>(null);
  let error = $state('');
  let dialog = $state<null | 'cancel' | 'end' | 'giveup' | 'delete'>(null);
  let copied = $state<'delete' | 'age-out'>('delete');

  $effect(() => {
    void move.updatedAt;
    api('GET', `/moves/${move.id}`).then((r) => { chunks = r.chunks; content = r.content ?? null; }).catch((e) => (error = errorText(e)));
  });

  let deleting = $state(false);
  async function remove() {
    error = '';
    dialog = null;
    deleting = true;
    try { await api('DELETE', `/moves/${move.id}`); onchange(); } catch (e) { error = errorText(e); }
    deleting = false;
  }
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
    <span>· {phaseText(move.phase, move.reason)}{move.phase !== 'rejected' && phaseReason(move.phase, move.reason) ? ` (${phaseReason(move.phase, move.reason)})` : ''}</span>
  </div>
  {#if move.phase === 'rejected'}
    <div class="refusal" data-testid="move-refusal">
      <strong data-testid="move-refused-by">{refusedByText(move) || 'Refused'}</strong>
      <p class="small" data-testid="move-refusal-reason">Reason: {refusalReason(move) || 'none given'}</p>
      {#if move.detail}<p class="small" data-testid="move-refusal-detail">Detail: <span class="verbatim">{move.detail}</span></p>
      {:else}<p class="muted small" data-testid="move-refusal-no-detail">No detail given{move.refusedBy === 'target' ? ` (${move.target.name} may need the cam-proxy update)` : ''}.</p>{/if}
      <p class="muted small">A refusal is final: start the move again once the cause is fixed.</p>
    </div>
  {/if}
  <p class="muted small" data-testid="move-bounds">{boundsText(move.bounds ?? null)}</p>
  {#if content}
    <div class="grid content" data-testid="move-content">
      <span class="muted small" data-testid="move-content-basis">Content: {contentBasisText(content.basis)}</span>
      {#if move.space}<span class="small" class:warn={!move.space.fits} data-testid="move-space">{spaceText(move.target.name, move.space)}</span>{/if}
      <ul>
        {#each content.kinds as k (k.kind)}
          <li class={k.included === true ? 'in' : k.included === false ? 'out' : 'open'} data-testid="move-content-{k.kind}">
            <span class="mark" aria-hidden="true">{k.included === true ? '✓' : k.included === false ? '–' : '?'}</span> {contentLine(k)}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
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
  {#if move.endRequested && move.phase === 'copying'}<p class="muted small" data-testid="move-end-waiting">The transfer ends as soon as Archive is copied. Ending it again changes nothing.</p>{/if}
  {#if move.cleanupPending}<p class="muted small" data-testid="move-cleanup-pending">Cleanup on {move.source.name} pending</p>{/if}
  {#if move.targetCleanupPending}<p class="muted small" data-testid="move-target-cleanup-pending">Cleanup on {move.target.name} pending</p>{/if}
  {#if error}<p class="error" data-testid="move-error">{error}</p>{/if}
  {#if cancelable(move.phase)}
    <div class="row">
      <button class="btn danger" data-testid="move-cancel" onclick={() => { copied = 'delete'; dialog = 'cancel'; }}>Cancel move…</button>
      {#if move.phase === 'copying'}<button class="btn" data-testid="move-end-transfer" disabled={move.endRequested} onclick={() => (dialog = 'end')}>{endLabel(move)}</button>{/if}
    </div>
  {/if}
  {#if canDelete(move.phase)}
    <div class="row">
      <button class="btn danger" data-testid="move-delete" disabled={deleting} onclick={() => (dialog = 'delete')}>Delete…</button>
    </div>
  {/if}
  {#if canGiveUp(move.phase)}
    <div class="row">
      <button class="btn danger" data-testid="move-give-up" onclick={() => (dialog = 'giveup')}>Give up copy back…</button>
    </div>
  {/if}
</div>

{#if dialog === 'cancel' && copyBack}
  <Confirm title="Cancel move" body="The move stops and the camera goes back to {move.source.name}. What {move.target.name} recorded since the switch-over is copied back to {move.source.name}; the old content never left {move.source.name}." typed="cancel" ok="Cancel move"
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
{:else if dialog === 'delete'}
  <Confirm title="Delete refused move" body="Delete the refused move of {move.cameraName || move.camsId} ({move.source.name} → {move.target.name})? Only this record goes; its audit entries stay."
    ok="Delete" cancel="Keep" onconfirm={remove} oncancel={() => (dialog = null)} />
{:else if dialog === 'giveup'}
  <Confirm title="Give up copy back" body="The copy back stops. Nothing is deleted on either proxy: the content stays where it is and ages out there."
    typed="give up" ok="Give up" onconfirm={() => run('give-up', { confirm: 'give up' })} oncancel={() => (dialog = null)} />
{/if}

<style>
  .small { font-size: 12px; margin: 0; }
  .link { background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; font: inherit; text-decoration: underline; }
  .choice { border: 0; padding: 0; margin: 0; display: grid; gap: 6px; }
  .check { display: flex; flex-direction: row; align-items: center; gap: 6px; color: var(--text); }
  .refusal { border-left: 3px solid var(--danger); padding: 4px 0 4px 10px; display: grid; gap: 4px; }
  .verbatim { font-family: var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
  .content ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; font-size: 13px; }
  .content li.out { color: var(--muted); }
  .content .mark { display: inline-block; width: 1em; text-align: center; }
  .content li.in .mark { color: var(--ok); }
  .warn { color: var(--warning); }
</style>
