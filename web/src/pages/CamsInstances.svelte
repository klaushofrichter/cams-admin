<script lang="ts">
  // P4: the cams instances (the cluster's cams, the Pi's) and a form for a new one.
  import { onMount } from 'svelte';
  import { api, errorText } from '../lib/api';
  import { instanceState, stateClass, stateText } from '../lib/cams';
  import { clock } from '../lib/clock.svelte';
  import Ago from '../components/Ago.svelte';

  let items = $state<any[]>([]);
  let accounts = $state<any[]>([]);
  let rows = $state<Record<string, any>>({});
  let name = $state('');
  let displayName = $state('');
  let chosen = $state<Record<string, boolean>>({});
  let error = $state('');

  async function load() {
    const [i, a, d] = await Promise.all([api('GET', '/cams-instances'), api('GET', '/accounts'), api('GET', '/dashboard')]);
    items = i.items;
    accounts = a.items;
    rows = Object.fromEntries(d.cams.map((c: any) => [c.id, c]));
  }
  onMount(() => { load().catch((e) => (error = errorText(e))); });
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;

  async function create(e: Event) {
    e.preventDefault();
    error = '';
    try {
      const i = await api('POST', '/cams-instances', { name, displayName: displayName || name, accounts: Object.keys(chosen).filter((k) => chosen[k]) });
      location.hash = `#/cams-instances/${i.id}`;
    } catch (err) { error = errorText(err); }
  }
</script>

<section class="card grid">
  <h2>cams instances</h2>
  <p class="muted">Each cams deployment that reads its configuration from cams-admin: the accounts it serves, its routes to the proxies, its key.</p>
  <div class="scroll-x">
    <table>
      <thead><tr><th>Instance</th><th>Accounts</th><th>State</th><th>Last pull</th><th>Mode</th><th class="hide-phone">Status</th></tr></thead>
      <tbody>
        {#each items as i (i.id)}
          {@const r = rows[i.id]}
          {@const st = r ? instanceState(r, clock.now) : 'never'}
          <tr data-testid="cms-row-{i.name}">
            <td><a href="#/cams-instances/{i.id}" data-testid="cms-open-{i.name}">{i.displayName}</a> <span class="mono muted">{i.name}</span></td>
            <td>{i.accounts.map(accountName).join(', ') || '—'}</td>
            <td><span class="chip {i.state === 'enrolled' ? 'ok' : i.state === 'revoked' ? 'bad' : ''}" data-testid="cms-state-{i.name}">{i.state === 'revoked' ? 'blocked' : i.state}</span></td>
            <td><Ago t={i.live.lastPullAt} /></td>
            <td>{r?.mode ?? '—'}</td>
            <td class="hide-phone"><span class="chip {stateClass(st)}">{stateText(st)}</span></td>
          </tr>
        {/each}
        {#if !items.length}<tr><td colspan="6" class="muted">No cams instance yet.</td></tr>{/if}
      </tbody>
    </table>
  </div>
  <form class="grid" onsubmit={create}>
    <div class="row">
      <label>Name<input data-testid="cms-name" bind:value={name} placeholder="cluster" required /></label>
      <label>Display name<input data-testid="cms-display" bind:value={displayName} placeholder="Cluster" /></label>
    </div>
    <div class="row" data-testid="cms-accounts">
      <span class="muted">Serves</span>
      {#each accounts as a (a.id)}<label class="check"><input type="checkbox" bind:checked={chosen[a.id]} data-testid="cms-account-{a.name}" /> {a.displayName}</label>{/each}
    </div>
    <div class="row"><button class="btn primary" data-testid="cms-create">New instance</button></div>
  </form>
  {#if error}<p class="error" data-testid="cms-error">{error}</p>{/if}
</section>

<style>
  h2 { margin: 0; }
  .check { display: flex; flex-direction: row; align-items: center; gap: 4px; color: var(--text); }
</style>
