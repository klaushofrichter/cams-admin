<script lang="ts">
  import { onMount } from 'svelte';
  import { api, errorText } from '../lib/api';
  import { when } from '../lib/format';

  let items = $state<any[]>([]);
  let next = $state<string | null>(null);
  let accounts = $state<any[]>([]);
  let account = $state('');
  let actorType = $state('');
  let action = $state('');
  let open = $state<Record<string, boolean>>({});
  let error = $state('');
  const ACTIONS = ['signin', 'signin-refused', 'signout', 'sessions-ended', 'account-create', 'account-update', 'account-delete', 'user-create', 'user-update', 'user-delete', 'proxy-create', 'proxy-update', 'proxy-delete', 'proxy-block', 'camera-create', 'camera-update', 'camera-delete', 'camera-adopt', 'sim-update', 'sim-delete', 'enrollment-code-create', 'enrollment-code-cancel', 'proxy-enrolled', 'key-confirmed', 'enroll-refused', 'key-revoke', 'proxy-auth-refused', 'backup-snapshot', 'backup-now', 'restore-detected', 'audit-throttled'];

  const q = (cursor?: string) => '/audit?' + new URLSearchParams({ limit: '50', ...(account && { account }), ...(actorType && { actorType }), ...(action && { action }), ...(cursor && { cursor }) }).toString();
  async function load(more = false) {
    try {
      const r = await api('GET', q(more ? next ?? undefined : undefined));
      items = more ? [...items, ...r.items] : r.items;
      next = r.nextCursor;
    } catch (e) { error = errorText(e); }
  }
  onMount(() => { load(); api('GET', '/accounts').then((r) => (accounts = r.items)); });
  const accName = (id: string | null) => accounts.find((a) => a.id === id)?.name ?? id ?? '';
</script>

<section class="card grid">
  <h2>Audit log</h2>
  <div class="row">
    <label>Account<select bind:value={account} onchange={() => load()} data-testid="audit-filter-account"><option value="">all</option>{#each accounts as a}<option value={a.id}>{a.name}</option>{/each}</select></label>
    <label>Actor<select bind:value={actorType} onchange={() => load()}><option value="">all</option><option>sysadmin</option><option>proxy</option><option>system</option></select></label>
    <label>Action<select bind:value={action} onchange={() => load()} data-testid="audit-filter-action"><option value="">all</option>{#each ACTIONS as a}<option>{a}</option>{/each}</select></label>
  </div>
  {#if error}<p class="error">{error}</p>{/if}
  <div class="scroll-x">
    <table>
      <thead><tr><th>Time</th><th>Action</th><th>Actor</th><th class="hide-phone">Account</th><th>Target</th><th>Outcome</th></tr></thead>
      <tbody>
        {#each items as r (r.id)}
          <tr data-testid="audit-row" data-action={r.action} onclick={() => (open[r.id] = !open[r.id])} class="click">
            <td>{when(r.at)}</td><td class="mono">{r.action}</td><td class="mono">{r.actor}</td><td class="hide-phone">{accName(r.accountId)}</td><td>{r.targetLabel ?? ''}</td>
            <td><span class="chip {r.outcome === 'ok' ? 'ok' : 'bad'}">{r.outcome}</span></td>
          </tr>
          {#if open[r.id]}<tr><td colspan="6"><pre class="mono">{JSON.stringify(r.detail, null, 2)}</pre></td></tr>{/if}
        {/each}
      </tbody>
    </table>
  </div>
  {#if next}<button class="btn" data-testid="audit-more" onclick={() => load(true)}>More</button>{/if}
</section>
<style>h2 { margin: 0; } .click { cursor: pointer; } pre { margin: 0; white-space: pre-wrap; }</style>
