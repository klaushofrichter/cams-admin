<script lang="ts">
  // Managed cams↔proxy tokens: stored as hashes, shown once (ShownOnce).
  // Rotation in P2: issue a new one, switch cams to it, then retire or revoke the old one.
  import { api, errorText } from '../lib/api';
  import { aheadText, cmdStateText, issueBlocked, tokenStateClass, tokenStateText } from '../lib/commands';
  import { when } from '../lib/format';
  import Confirm from './Confirm.svelte';
  import ShownOnce from './ShownOnce.svelte';

  let { accountId, proxyId, proxyName, policy, allow, refresh }: { accountId: string; proxyId: string; proxyName: string; policy: string; allow: string[]; refresh: number } = $props();
  const base = $derived(`/accounts/${accountId}/proxies/${proxyId}/tokens`);
  let data = $state<{ revision: number; appliedRevision: number; ahead: number | null; items: any[] } | null>(null);
  let error = $state('');
  let label = $state('cams');
  let hours = $state(24);
  let shown = $state<string | null>(null);
  let revoking = $state<any>(null);

  async function load() {
    try { data = await api('GET', base); } catch (e) { error = errorText(e); }
  }
  $effect(() => { void refresh; load(); });

  async function issue(kind: 'client' | 'admin') {
    error = '';
    try {
      const r = await api('POST', base, { kind, label });
      shown = r.token;
      await load();
    } catch (e) { error = errorText(e); }
  }
  async function retire(t: any) {
    error = '';
    try { await api('POST', `${base}/${t.id}/retire`, { hours: Number(hours) }); await load(); } catch (e) { error = errorText(e); }
  }
  async function revoke() {
    const t = revoking;
    revoking = null;
    error = '';
    try { await api('POST', `${base}/${t.id}/revoke`, {}); await load(); } catch (e) { error = errorText(e); }
  }
  async function confirmRestore() {
    error = '';
    try { await api('POST', `${base}/confirm-restore`, {}); await load(); } catch (e) { error = errorText(e); }
  }
  async function reapply() {
    error = '';
    try { await api('POST', `${base}/apply`, {}); await load(); } catch (e) { error = errorText(e); }
  }
  const whyClient = $derived(data?.ahead != null ? 'confirm the restore first' : issueBlocked('client', policy, allow));
  const whyAdmin = $derived(data?.ahead != null ? 'confirm the restore first' : issueBlocked('admin', policy, allow));
</script>

<section class="card grid" data-testid="tokens">
  <h3>Tokens (cams ↔ proxy)</h3>
  <p class="muted">cams-admin stores only a hash of each token and shows a new token once. Rotate: issue a new one, switch cams to it, then retire or revoke the old one.</p>
  {#if error}<p class="error" data-testid="tokens-error">{error}</p>{/if}
  {#if data?.ahead != null}
    <div class="banner grid" data-testid="tokens-ahead">
      <p>{aheadText(data.ahead, data.revision)}</p>
      <div><button class="btn primary" data-testid="tokens-confirm-restore" onclick={confirmRestore}>Confirm and send the set above revision {data.ahead}</button></div>
    </div>
  {/if}
  {#if policy !== 'unsupported'}
    <div class="row">
      <label>Label<input bind:value={label} maxlength="64" data-testid="token-label" /></label>
      <button class="btn primary" data-testid="issue-client" disabled={!!whyClient} onclick={() => issue('client')}>Issue client token</button>
      <button class="btn" data-testid="issue-admin" disabled={!!whyAdmin} onclick={() => issue('admin')}>Issue admin token</button>
      {#if whyClient}<span class="muted" data-testid="issue-client-why">{whyClient}</span>{:else if whyAdmin}<span class="muted" data-testid="issue-admin-why">{whyAdmin}</span>{/if}
    </div>
  {:else}
    <p class="muted" data-testid="tokens-unsupported">Tokens are managed once the proxy runs a version that takes commands.</p>
  {/if}
  {#if data?.items.length}
    <p class="muted">A leaked token: block it on the proxy itself first (its admin page's <b>block token</b>, takes effect at once), then revoke it here. A revoke is kept here at once and reaches the proxy as soon as it takes the set, also while it is paused.</p>
    <div class="row muted">
      <span>revision {data.revision}{data.appliedRevision !== data.revision ? ` (proxy confirmed ${data.appliedRevision})` : ''}</span>
      {#if policy === 'allowed'}<button class="btn" data-testid="tokens-reapply" onclick={reapply}>Re-apply</button>{/if}
      <label>Retire after (h)<input type="number" min="1" max="168" bind:value={hours} data-testid="retire-hours" /></label>
    </div>
    <div class="scroll-x">
      <table data-testid="tokens-list">
        <thead><tr><th>Token</th><th>Kind</th><th>Label</th><th>State</th><th>Issued</th><th>Retires / revoked</th><th>Last apply</th><th></th></tr></thead>
        <tbody>
          {#each data.items as t (t.id)}
            <tr data-testid="token-row-{t.id}">
              <td class="mono">{t.id}<br /><span class="muted">{t.hashPrefix}…</span></td>
              <td>{t.kind}</td><td>{t.label}</td>
              <td><span class="chip {tokenStateClass(t.state, t.onProxy)}" data-testid="token-state-{t.id}">{tokenStateText(t)}</span></td>
              <td>{when(t.createdAt)}<br /><span class="muted">{t.createdBy}</span></td>
              <td>{t.revokedAt ? when(t.revokedAt) : t.retireAt ? when(t.retireAt) : '—'}</td>
              <td>{t.lastCommand ? cmdStateText(t.lastCommand.state, t.lastCommand.outcomeCode) : '—'}</td>
              <td class="actions">
                {#if t.state === 'active' && policy === 'allowed'}<button class="btn" data-testid="token-retire-{t.id}" onclick={() => retire(t)}>Retire</button>{/if}
                {#if t.state !== 'revoked'}<button class="btn danger" data-testid="token-revoke-{t.id}" onclick={() => (revoking = t)}>Revoke</button>{/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

{#if shown}
  <ShownOnce token={shown} {proxyName} onclose={() => (shown = null)} />
{/if}
{#if revoking}
  <Confirm title="Revoke {revoking.label}" body="Revoked here at once; the proxy stops accepting it when it takes the new set (also while paused). For a leaked token, block it on the proxy first. cams instances still using it lose access to this proxy." ok="Revoke" onconfirm={revoke} oncancel={() => (revoking = null)} />
{/if}

<style>
  h3, p { margin: 0; }
  .actions { white-space: nowrap; }
  input[type='number'] { width: 5em; }
  .banner { border: 1px solid var(--warning); border-radius: 8px; padding: 10px; }
</style>
