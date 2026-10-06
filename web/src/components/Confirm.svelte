<script lang="ts">
  // A confirmation dialog; with `typed`, the user must type that text.
  let { title, body, typed = '', ok = 'Confirm', onconfirm, oncancel }: { title: string; body: string; typed?: string; ok?: string; onconfirm: () => void; oncancel: () => void } = $props();
  let value = $state('');
</script>
<div class="scrim" role="presentation" onclick={oncancel}></div>
<div class="dialog card" role="dialog" aria-modal="true" aria-label={title} data-testid="confirm">
  <h3>{title}</h3>
  <p>{body}</p>
  {#if typed}
    <label>Type <b class="mono">{typed}</b> to confirm<input data-testid="confirm-input" bind:value autocomplete="off" /></label>
  {/if}
  <div class="row end">
    <button class="btn" data-testid="confirm-cancel" onclick={oncancel}>Cancel</button>
    <button class="btn danger" data-testid="confirm-ok" disabled={!!typed && value !== typed} onclick={onconfirm}>{ok}</button>
  </div>
</div>
<style>
  .scrim { position: fixed; inset: 0; background: var(--scrim); z-index: 10; }
  .dialog { position: fixed; z-index: 11; left: 50%; top: 20%; transform: translateX(-50%); width: min(460px, calc(100vw - 32px)); box-shadow: var(--shadow); display: grid; gap: 12px; }
  h3 { margin: 0; }
  p { margin: 0; }
  .end { justify-content: flex-end; }
</style>
