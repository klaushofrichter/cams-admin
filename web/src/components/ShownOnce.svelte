<script lang="ts">
  // A managed token, shown once. It lives only in this component's state
  // (never in the URL, localStorage or the router) and is gone on Close.
  let { token, proxyName, onclose }: { token: string; proxyName: string; onclose: () => void } = $props();
  let stored = $state(false);
  const copy = () => navigator.clipboard?.writeText(token);
</script>
<div class="scrim" role="presentation"></div>
<div class="dialog card" role="dialog" aria-modal="true" aria-label="New token" data-testid="shown-once">
  <h3>New token for {proxyName}</h3>
  <div class="row"><input class="mono" readonly value={token} data-testid="shown-token" autocomplete="off" spellcheck="false" /><button class="btn" onclick={copy}>Copy</button></div>
  <p>
    This is the only time cams-admin shows this token. Put it in cams's <code>cameras-config.json</code> as this proxy's <code>token</code>
    (cluster: the <code>cams-cameras</code> Secret, through kube-setup). If you lose it, revoke it and issue a new one.
  </p>
  <label class="row"><input type="checkbox" bind:checked={stored} data-testid="shown-stored" /> I have stored it</label>
  <div class="row end"><button class="btn primary" data-testid="shown-close" disabled={!stored} onclick={onclose}>Close</button></div>
</div>
<style>
  .scrim { position: fixed; inset: 0; background: var(--scrim); z-index: 10; }
  .dialog { position: fixed; z-index: 11; left: 50%; top: 15%; transform: translateX(-50%); width: min(560px, calc(100vw - 32px)); box-shadow: var(--shadow); display: grid; gap: 12px; }
  h3, p { margin: 0; }
  input[readonly] { flex: 1; min-width: 0; }
  .end { justify-content: flex-end; }
</style>
