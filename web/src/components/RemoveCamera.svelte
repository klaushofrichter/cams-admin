<script lang="ts">
  // Remove from proxy (spec 2026-11-08 B4): what the proxy holds (camera.remove.preview), keep or delete now, the
  // archive only when asked, typed confirm (the cams id). The proxy's done answer deletes the record (server side).
  // Proxy offline or too old: Delete record only (today's Delete).
  import { onMount } from 'svelte';
  import { api, ApiFailure, errorWhy } from '../lib/api';
  import { waitCommand } from '../lib/config';
  import { archiveOffered, removeAnswerText, removeLines, type RemoveContent, type RemovePreview } from '../lib/decommission';
  import DeleteLines from './DeleteLines.svelte';

  let { accountId, camera, onclose, ondone, ondeleterecord }: { accountId: string; camera: any; onclose: () => void; ondone: () => void; ondeleterecord: () => void } = $props();

  let preview = $state<(RemovePreview & { proxyId: string }) | null>(null);
  let previewError = $state('');
  let offline = $state(false);
  let content = $state<RemoveContent>('keep');
  let archive = $state(false);
  let typed = $state('');
  let busy = $state(false);
  let result = $state('');
  let error = $state('');
  let done = $state(false);

  onMount(async () => {
    try {
      preview = await api('GET', `/accounts/${accountId}/cameras/${camera.id}/remove-preview`);
    } catch (e) {
      previewError = errorWhy(e);
      offline = e instanceof ApiFailure && ['proxy_offline', 'proxy_update_needed', 'not_allowed_on_proxy', 'timeout', 'unsupported_by_proxy', 'not_enrolled'].includes(e.code);
    }
  });
  $effect(() => { if (!archiveOffered(preview, content)) archive = false; });
  const lines = $derived(preview ? removeLines(preview, content, archive) : null);

  async function remove() {
    if (!preview) return;
    busy = true;
    error = result = '';
    try {
      const r = await api<{ commandId: string }>('POST', `/accounts/${accountId}/cameras/${camera.id}/remove`, { content, archive, confirm: typed });
      result = 'Sent, waiting for the proxy…';
      const row = await waitCommand(() => api('GET', `/accounts/${accountId}/commands/${r.commandId}`), 60_000, 1000);
      if (!row) result = 'No answer from the proxy yet: the record goes once it answers.';
      else if (row.state === 'done') { result = removeAnswerText(row.result); done = true; ondone(); }
      else { result = ''; error = `The proxy did not remove it (${row.state}${row.outcomeCode ? `: ${row.outcomeCode}` : ''}); the record stays.`; }
    } catch (e) {
      result = '';
      error = errorWhy(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="scrim" role="presentation" onclick={onclose}></div>
<div class="dialog card" role="dialog" aria-modal="true" aria-label="Remove {camera.camsId} from its proxy" data-testid="remove-camera">
  <h3>Remove {camera.camsId} from its proxy</h3>
  {#if done}
    <p data-testid="remove-camera-result">{result}</p>
    <p class="muted">The camera's record is deleted. cams viewers drop it at their next pull.</p>
    <div class="row end"><button class="btn" data-testid="remove-camera-close" onclick={onclose}>Close</button></div>
  {:else}
    <p>The proxy stops using the camera (its FTP upload, settings, stored password, certificate trust and PTZ positions), then cams-admin deletes the camera's record.</p>
    {#if previewError}
      <p class="error" data-testid="remove-camera-preview-error">{previewError}</p>
      {#if offline}
        <p class="muted" data-testid="remove-camera-offline">Without the proxy, only the record can go: remove the camera on the proxy itself later.</p>
        <div class="row end">
          <button class="btn" onclick={onclose}>Cancel</button>
          <button class="btn danger" data-testid="remove-camera-record-only" onclick={ondeleterecord}>Delete record only</button>
        </div>
      {:else}
        <div class="row end"><button class="btn" onclick={onclose}>Close</button></div>
      {/if}
    {:else if !preview}
      <p class="muted" data-testid="remove-camera-loading">Asking the proxy what it holds…</p>
    {:else}
      <fieldset class="grid">
        <legend>Its clips and stills on the proxy</legend>
        <label><input type="radio" bind:group={content} value="keep" data-testid="remove-camera-keep" /> Keep until retention ages them out</label>
        <label><input type="radio" bind:group={content} value="delete" data-testid="remove-camera-delete" /> Delete now</label>
        {#if archiveOffered(preview, content)}
          <label><input type="checkbox" bind:checked={archive} data-testid="remove-camera-archive" /> Also delete its archived clips ({preview.archivedClips})</label>
        {/if}
      </fieldset>
      <DeleteLines {lines} testid="remove-camera-lines" />
      <label>Type <b class="mono">{camera.camsId}</b> to confirm<input data-testid="remove-camera-input" bind:value={typed} autocomplete="off" /></label>
      {#if result}<p class="muted" data-testid="remove-camera-progress">{result}</p>{/if}
      {#if error}<p class="error" data-testid="remove-camera-error">{error}</p>{/if}
      <div class="row end">
        <button class="btn" data-testid="remove-camera-cancel" onclick={onclose}>Cancel</button>
        <button class="btn danger" data-testid="remove-camera-ok" disabled={busy || typed !== camera.camsId} onclick={remove}>{busy ? 'Removing…' : 'Remove from proxy'}</button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .scrim { position: fixed; inset: 0; background: var(--scrim); z-index: 10; }
  .dialog { position: fixed; z-index: 11; left: 50%; top: 10%; transform: translateX(-50%); width: min(520px, calc(100vw - 32px)); max-height: 80vh; overflow: auto; box-shadow: var(--shadow); display: grid; gap: 12px; }
  h3, p { margin: 0; }
  fieldset { border: 1px solid var(--border); border-radius: 8px; gap: 6px; }
  .end { justify-content: flex-end; }
</style>
