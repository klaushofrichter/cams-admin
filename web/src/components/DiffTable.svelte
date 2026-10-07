<script lang="ts">
  // A settings change list (a dry run's or a real write's), as text.
  import { narrowNote, valueText, type Change } from '../lib/config';
  let { changes, unchanged = [], testid = 'diff' }: { changes: Change[]; unchanged?: string[]; testid?: string } = $props();
</script>
<div class="scroll-x" data-testid={testid}>
  {#if changes.length}
    <table>
      <thead><tr><th>Setting</th><th>Now</th><th></th><th>After</th><th></th></tr></thead>
      <tbody>
        {#each changes as c (c.path)}
          <tr data-testid="{testid}-row-{c.path}">
            <td class="mono">{c.path}</td>
            <td><span class="mono">{valueText(c.from)}</span> <span class="muted">({c.sourceFrom})</span></td>
            <td>→</td>
            <td><span class="mono">{valueText(c.to)}</span> <span class="muted">({c.sourceTo})</span></td>
            <td>
              {#if c.restart}<span class="badge warn">{c.restart === 'process' ? 'needs a new process' : 'needs a restart'}</span>{/if}
              {#if narrowNote(c.path)}<span class="muted">{narrowNote(c.path)}</span>{/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    <p class="muted">Nothing would change.</p>
  {/if}
  {#if unchanged.length}<p class="muted">Unchanged: <span class="mono">{unchanged.join(', ')}</span></p>{/if}
</div>
