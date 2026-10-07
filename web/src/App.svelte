<script lang="ts">
  import { onMount } from 'svelte';
  import { api, setUnauthorized, WRITE_HEADERS } from './lib/api';
  import { parse, type Route } from './lib/router';
  import SignIn from './pages/SignIn.svelte';
  import Dashboard from './pages/Dashboard.svelte';
  import Accounts from './pages/Accounts.svelte';
  import Account from './pages/Account.svelte';
  import Proxy from './pages/Proxy.svelte';
  import CamsInstances from './pages/CamsInstances.svelte';
  import CamsInstance from './pages/CamsInstance.svelte';
  import Audit from './pages/Audit.svelte';
  import Backup from './pages/Backup.svelte';

  let me = $state<{ email: string; expiresAt: number } | null>(null);
  let checked = $state(false);
  let route = $state<Route>(parse(location.hash));

  setUnauthorized(() => (me = null));
  onMount(() => {
    api('GET', '/me').then((m) => (me = m)).catch(() => (me = null)).finally(() => (checked = true));
    const on = () => (route = parse(location.hash));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  });

  async function signOut() {
    const r = await fetch('/auth/logout', { method: 'POST', headers: WRITE_HEADERS, body: '{}' });
    if (r.ok) location.href = '/auth/signed-out';
  }
</script>

{#if !checked}
  <p class="muted pad">Loading…</p>
{:else if !me}
  <SignIn />
{:else}
  <header class="top">
    <a href="#/" class="brand">cams-admin</a>
    <nav class="row">
      <a href="#/" data-testid="nav-dashboard" class:on={route.page === 'dashboard'}>Dashboard</a>
      <a href="#/accounts" data-testid="nav-accounts" class:on={route.page === 'accounts' || route.page === 'account' || route.page === 'proxy'}>Accounts</a>
      <a href="#/cams-instances" data-testid="nav-cams" class:on={route.page === 'cams-instances' || route.page === 'cams-instance'}>cams</a>
      <a href="#/audit" data-testid="nav-audit" class:on={route.page === 'audit'}>Audit</a>
      <a href="#/backup" data-testid="nav-backup" class:on={route.page === 'backup'}>Backup</a>
    </nav>
    <span class="who muted hide-phone" data-testid="me">{me.email}</span>
    <button class="btn" data-testid="signout" onclick={signOut}>Sign out</button>
  </header>
  <main class="page">
    {#if route.page === 'dashboard'}<Dashboard />
    {:else if route.page === 'accounts'}<Accounts />
    {:else if route.page === 'account'}{#key route.accountId}<Account accountId={route.accountId!} tab={route.tab ?? 'overview'} />{/key}
    {:else if route.page === 'proxy'}{#key route.proxyId}<Proxy accountId={route.accountId!} proxyId={route.proxyId!} camera={route.camera} />{/key}
    {:else if route.page === 'cams-instances'}<CamsInstances />
    {:else if route.page === 'cams-instance'}{#key route.instanceId}<CamsInstance instanceId={route.instanceId!} />{/key}
    {:else if route.page === 'audit'}<Audit />
    {:else if route.page === 'backup'}<Backup />
    {/if}
  </main>
{/if}

<style>
  .pad { padding: 16px; }
  .top { display: flex; gap: 16px; align-items: center; padding: 10px 16px; background: var(--chrome); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .brand { font-weight: 700; text-decoration: none; background: var(--grad); -webkit-background-clip: text; background-clip: text; color: transparent; }
  nav a { text-decoration: none; color: var(--muted); padding: 2px 6px; border-radius: 6px; }
  nav a.on { color: var(--text); background: var(--surface-2); }
  .who { margin-left: auto; font-size: 13px; }
  .page { max-width: 1200px; margin: 0 auto; padding: 16px; display: grid; gap: 16px; }
  @media (max-width: 640px) { .top { gap: 8px; } .page { padding: 12px 8px; } }
</style>
