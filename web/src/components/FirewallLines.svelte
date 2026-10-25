<script lang="ts">
  // Firewall lines for a person to run on a proxy's host, with a copy button. Plain text: nothing runs them.
  let { lines, testid }: { lines: string[]; testid: string } = $props();
  let copied = $state(false);
  async function copy() {
    try {
      await navigator.clipboard?.writeText(lines.join('\n') + '\n');
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch { copied = false; }
  }
</script>

<div class="fw" data-testid={testid}>
  <pre class="mono" data-testid="{testid}-lines">{lines.join('\n')}</pre>
  <button class="btn" type="button" data-testid="{testid}-copy" onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
</div>

<style>
  .fw { display: flex; gap: 8px; align-items: flex-start; flex-wrap: wrap; }
  pre { margin: 0; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-2); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; flex: 1 1 280px; min-width: 0; }
</style>
