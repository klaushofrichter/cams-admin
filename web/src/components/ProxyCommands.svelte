<script lang="ts">
  // The proxy's command policy (as it reports it) and cams-admin's command history.
  import { api, errorText } from '../lib/api';
  import { cmdStateClass, cmdStateText, commandsText } from '../lib/commands';
  import { when } from '../lib/format';

  let { accountId, proxyId, policy, allow, refresh }: { accountId: string; proxyId: string; policy: string; allow: string[]; refresh: number } = $props();
  let items = $state<any[]>([]);
  let next = $state<string | null>(null);
  let error = $state('');

  async function load() {
    try {
      const r = await api('GET', `/accounts/${accountId}/proxies/${proxyId}/commands?limit=20`);
      items = r.items;
      next = r.nextCursor;
    } catch (e) { error = errorText(e); }
  }
  async function more() {
    try {
      const r = await api('GET', `/accounts/${accountId}/proxies/${proxyId}/commands?limit=20&cursor=${encodeURIComponent(next!)}`);
      items = [...items, ...r.items];
      next = r.nextCursor;
    } catch (e) { error = errorText(e); }
  }
  $effect(() => { void refresh; load(); });
</script>

<section class="card grid" data-testid="commands">
  <h3>Commands</h3>
  <p class:muted={policy !== 'allowed'} data-testid="commands-policy">{commandsText(policy, allow)}</p>
  {#if error}<p class="error">{error}</p>{/if}
  {#if items.length}
    <div class="scroll-x">
      <table data-testid="commands-list">
        <thead><tr><th>When</th><th>By</th><th>Command</th><th>State</th></tr></thead>
        <tbody>
          {#each items as c (c.id)}
            <tr data-testid="command-{c.id}">
              <td>{when(c.createdAt)}</td><td>{c.actor}</td>
              <td class="mono">{c.command}{c.args?.revision !== undefined ? ` r${c.args.revision}` : ''}{c.attempts > 1 ? ` ×${c.attempts}` : ''}</td>
              <td><span class="chip {cmdStateClass(c.state)}" data-testid="command-state-{c.id}">{cmdStateText(c.state, c.outcomeCode)}</span></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if next}<button class="btn" data-testid="commands-more" onclick={more}>More</button>{/if}
  {:else}
    <p class="muted">No commands sent yet.</p>
  {/if}
</section>
