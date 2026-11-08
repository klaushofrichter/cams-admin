<script lang="ts">
  // Decommission (spec 2026-11-08 B5): the proxy unenrolls itself (proxy.unenroll: key file, cams-admin address, its
  // token set and the command policy cams-admin set), then its record goes as with Delete (server side, on the done
  // answer). Disabled while the proxy reports cameras (linked). Offline: Delete record only, and admin-unenroll on the host.
  import { onMount } from 'svelte';
  import { api, errorWhy } from '../lib/api';
  import { waitCommand } from '../lib/config';
  import { decommissionLines, OFFLINE_DECOMMISSION, type DecommissionPreview } from '../lib/decommission';
  import DeleteLines from './DeleteLines.svelte';

  let { accountId, proxy, onclose, ondeleterecord }: { accountId: string; proxy: { id: string; name: string }; onclose: () => void; ondeleterecord: () => void } = $props();

  let pre = $state<DecommissionPreview | null>(null);
  let typed = $state('');
  let busy = $state(false);
  let progress = $state('');
  let error = $state('');
  let done = $state(false);
  onMount(async () => {
    try { pre = await api('GET', `/accounts/${accountId}/proxies/${proxy.id}/decommission-preview`); } catch (e) { error = errorWhy(e); }
  });
  const lines = $derived(pre ? decommissionLines(pre) : null);

  async function go() {
    busy = true;
    error = progress = '';
    try {
      const r = await api<{ commandId: string }>('POST', `/accounts/${accountId}/proxies/${proxy.id}/decommission`, { confirm: typed });
      progress = 'Sent, waiting for the proxy…';
      const row = await waitCommand(() => api('GET', `/accounts/${accountId}/commands/${r.commandId}`), 60_000, 1000);
      if (!row) progress = 'No answer from the proxy yet: its record goes once it answers.';
      else if (row.state === 'done') { done = true; progress = ''; }
      else { progress = ''; error = `The proxy did not unenroll (${row.state}${row.outcomeCode ? `: ${row.outcomeCode}` : ''}); the record stays.`; }
    } catch (e) {
      progress = '';
      error = errorWhy(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="scrim" role="presentation" onclick={onclose}></div>
<div class="dialog card" role="dialog" aria-modal="true" aria-label="Decommission {proxy.name}" data-testid="decommission">
  <h3>Decommission {proxy.name}</h3>
  {#if done}
    <p data-testid="decommission-done">The proxy unenrolled itself and its record is deleted.</p>
    <div class="row end"><button class="btn" data-testid="decommission-close" onclick={() => (location.hash = `#/accounts/${accountId}/proxies`)}>Close</button></div>
  {:else if !pre}
    {#if error}<p class="error">{error}</p>{:else}<p class="muted">Counting what goes…</p>{/if}
  {:else if !pre.connected}
    <p class="muted" data-testid="decommission-offline">{OFFLINE_DECOMMISSION}</p>
    <div class="row end">
      <button class="btn" onclick={onclose}>Cancel</button>
      <button class="btn danger" data-testid="decommission-record-only" onclick={ondeleterecord}>Delete record only</button>
    </div>
  {:else}
    <p>The proxy unenrolls itself and forgets what cams-admin gave it; then cams-admin deletes its record. To use it again, add it anew and enroll it with a new code.</p>
    {#if pre.reportedCameras.length}
      <p data-testid="decommission-cameras">Cameras on it:
        {#each pre.reportedCameras as c, i (c)}{i ? ', ' : ''}<a class="mono" href="#/accounts/{accountId}/proxies/{proxy.id}?camera={encodeURIComponent(c)}">{c}</a>{/each}
        (remove each from the account's Cameras tab, Remove from proxy…)</p>
    {/if}
    <DeleteLines {lines} testid="decommission-lines" />
    <label>Type <b class="mono">{proxy.name}</b> to confirm<input data-testid="decommission-input" bind:value={typed} autocomplete="off" disabled={!!lines?.blocked} /></label>
    {#if progress}<p class="muted" data-testid="decommission-progress">{progress}</p>{/if}
    {#if error}<p class="error" data-testid="decommission-error">{error}</p>{/if}
    <div class="row end">
      <button class="btn" data-testid="decommission-cancel" onclick={onclose}>Cancel</button>
      <button class="btn danger" data-testid="decommission-ok" disabled={busy || !!lines?.blocked || typed !== proxy.name} onclick={go}>{busy ? 'Decommissioning…' : 'Decommission'}</button>
    </div>
  {/if}
</div>

<style>
  .scrim { position: fixed; inset: 0; background: var(--scrim); z-index: 10; }
  .dialog { position: fixed; z-index: 11; left: 50%; top: 10%; transform: translateX(-50%); width: min(520px, calc(100vw - 32px)); max-height: 80vh; overflow: auto; box-shadow: var(--shadow); display: grid; gap: 12px; }
  h3, p { margin: 0; }
  .end { justify-content: flex-end; }
</style>
