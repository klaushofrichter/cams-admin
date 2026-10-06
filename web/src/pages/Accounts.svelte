<script lang="ts">
  import { onMount } from 'svelte';
  import { api, errorText } from '../lib/api';

  let items = $state<any[]>([]);
  let name = $state('');
  let displayName = $state('');
  let error = $state('');
  const load = () => api('GET', '/accounts').then((r) => (items = r.items));
  onMount(load);

  async function create(e: Event) {
    e.preventDefault();
    error = '';
    try {
      const a = await api('POST', '/accounts', { name, displayName });
      name = displayName = '';
      location.hash = `#/accounts/${a.id}`;
    } catch (err) {
      error = errorText(err);
    }
  }
</script>

<section class="card grid">
  <h2>Accounts</h2>
  <div class="scroll-x">
    <table>
      <thead><tr><th>Name</th><th>Display name</th><th>Users</th><th>Proxies</th><th>Cameras</th></tr></thead>
      <tbody>
        {#each items as a (a.id)}
          <tr data-testid="account-row-{a.name}">
            <td><a href="#/accounts/{a.id}" class="mono" data-testid="account-link-{a.name}">{a.name}</a></td>
            <td>{a.displayName} {#if a.admins === 0}<span class="badge warn">no admin</span>{/if}</td>
            <td>{a.users}</td><td>{a.proxies}</td><td>{a.cameras}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <form class="row" onsubmit={create}>
    <label>Account name<input data-testid="new-account-name" bind:value={name} placeholder="home" required /></label>
    <label>Display name<input data-testid="new-account-display" bind:value={displayName} placeholder="Home" required /></label>
    <button class="btn primary" data-testid="new-account-submit">New account</button>
  </form>
  {#if error}<p class="error" data-testid="new-account-error">{error}</p>{/if}
</section>
<style>h2 { margin: 0; } form { align-items: end; }</style>
