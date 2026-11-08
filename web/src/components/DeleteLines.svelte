<script lang="ts">
  // Inside a Delete confirmation: what goes, what stays, and what refuses it (lib/deletes.ts).
  import type { DeleteLines } from '../lib/deletes';
  let { lines, testid = 'delete-lines' }: { lines: DeleteLines | null; testid?: string } = $props();
</script>
{#if lines}
  <div class="grid lines" data-testid={testid}>
    {#if lines.blocked}<p class="error" data-testid="{testid}-blocked">{lines.blocked}</p>{/if}
    <div><b>Deleted</b><ul data-testid="{testid}-goes">{#each lines.goes as l}<li>{l}</li>{/each}</ul></div>
    <div><b>Kept</b><ul data-testid="{testid}-stays">{#each lines.stays as l}<li>{l}</li>{/each}</ul></div>
  </div>
{:else}
  <p class="muted" data-testid="{testid}-loading">Counting what goes…</p>
{/if}
<style>
  .lines { gap: 6px; }
  ul { margin: 2px 0 0; padding-left: 20px; }
  p { margin: 0; }
</style>
