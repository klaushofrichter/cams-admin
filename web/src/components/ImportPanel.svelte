<script lang="ts">
  // P4: import cams's redacted export into this account (dry run first), and
  // export a cameras.json for cams's file mode, per cams instance.
  import { onMount } from 'svelte';
  import { api, errorText } from '../lib/api';
  import { importSummary } from '../lib/cams';
  import { bytes } from '../lib/format';
  import Confirm from './Confirm.svelte';

  let { accountId, accountName }: { accountId: string; accountName: string } = $props();
  const MAX = 1024 * 1024;
  let instances = $state<any[]>([]);
  let instanceId = $state('');
  let file = $state<unknown>(null);
  let fileInfo = $state('');
  let createProxies = $state(false);
  let hideUnlisted = $state(false);
  let accepted = $state<Record<string, boolean>>({});
  let result = $state<any>(null);
  let confirmApply = $state(false);
  let error = $state('');
  let busy = $state(false);

  onMount(async () => {
    try {
      instances = (await api('GET', '/cams-instances')).items.filter((i: any) => i.accounts.includes(accountId));
      instanceId = instances[0]?.id ?? '';
    } catch (e) { error = errorText(e); }
  });

  async function pick(e: Event) {
    error = '';
    result = null;
    file = null;
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    if (f.size > MAX) { error = 'The file is over 1 MiB.'; return; }
    try {
      file = JSON.parse(await f.text());
      fileInfo = `${f.name}, ${bytes(f.size)}`;
    } catch { error = 'Not a JSON file.'; }
  }

  async function run(apply: boolean) {
    error = '';
    busy = true;
    try {
      result = await api('POST', `/accounts/${accountId}/import`, {
        instanceId, file, apply, createProxies, hideUnlisted, acceptMismatch: Object.keys(accepted).filter((k) => accepted[k]),
      });
    } catch (e) { error = errorText(e); }
    busy = false;
  }

  async function exportFile(i: any) {
    error = '';
    try {
      const r = await fetch(`/api/v1/accounts/${accountId}/export?instance=${encodeURIComponent(i.id)}`, { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`export: ${r.status}`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(await r.json(), null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `cameras-${accountName}-${i.name}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { error = String(e); }
  }

  const describe = (c: any): string => {
    switch (c.kind) {
      case 'proxy-matched': return `proxy ${c.name}: matched by ${c.by}`;
      case 'proxy-new': return `new proxy ${c.name} (${c.url})`;
      case 'route-add': return `route ${c.name} → ${c.url}`;
      case 'route-change': return `route ${c.name}: ${c.was ?? '(hidden)'} → ${c.url}`;
      case 'route-hide': return `hide ${c.name} for this instance`;
      case 'camera-new': return `new camera ${c.camsId}`;
      case 'camera-change': return `camera ${c.camsId}: ${Object.entries(c.fields).map(([k, v]: [string, any]) => `${k} ${JSON.stringify(v.from)} → ${JSON.stringify(v.to)}`).join(', ')}`;
      case 'pins-set': return `pins of ${c.name}: ${c.to.join(', ')}`;
      case 'proxy-tls-name': return `TLS name of ${c.name}: ${c.to}`;
      case 'token-external': return `external ${c.tokenKind} token on ${c.name} (${c.hashPrefix})`;
      case 'registry-only': return `camera ${c.camsId}: in the registry, not in the file (kept)`;
      default: return c.kind;
    }
  };
  const summary = $derived(result ? importSummary(result) : []);
  const allAccepted = $derived(!!result && result.mismatches.every((m: any) => accepted[m.id]));
</script>

<div class="grid" data-testid="import-panel">
  {#if !instances.length}
    <p class="muted">No cams instance serves this account yet (<a href="#/cams-instances">cams instances</a>).</p>
  {:else}
    <div class="row">
      <label>cams instance<select bind:value={instanceId} data-testid="import-instance" onchange={() => (result = null)}>{#each instances as i (i.id)}<option value={i.id}>{i.name}</option>{/each}</select></label>
      <label>Export of cams (<code>export-config</code>)<input type="file" accept="application/json,.json" onchange={pick} data-testid="import-file" /></label>
      {#if fileInfo}<span class="muted" data-testid="import-file-info">{fileInfo}</span>{/if}
    </div>
    <div class="row">
      <label class="check"><input type="checkbox" bind:checked={createProxies} data-testid="import-create-proxies" /> create proxies the registry doesn't know</label>
      <label class="check"><input type="checkbox" bind:checked={hideUnlisted} data-testid="import-hide-unlisted" /> hide proxies this file doesn't use (for this instance)</label>
    </div>
    <div class="row">
      <button class="btn" data-testid="import-dry-run" disabled={!file || busy} onclick={() => run(false)}>Dry run</button>
      {#if result && !result.noChanges}<button class="btn primary" data-testid="import-apply" disabled={busy || result.blockers.some((b: string) => b !== 'unknown_proxy' || !createProxies) || !allAccepted} onclick={() => (confirmApply = true)}>Apply</button>{/if}
    </div>
    {#if result}
      <div class="grid" data-testid="import-result">
        {#if result.noChanges}<p data-testid="import-no-changes"><b>No changes.</b> The registry already matches this file.</p>
        {:else if result.applied}<p data-testid="import-applied"><b>Applied.</b></p>{/if}
        <div class="row">{#each summary as s}<span class="badge" data-testid="import-count">{s.count} {s.label}</span>{/each}</div>
        <ul class="changes">{#each result.changes as c}<li class="mono" data-testid="import-change">{describe(c)}</li>{/each}</ul>
        {#if result.mismatches.length}
          <div data-testid="import-mismatches"><b>Mismatches with the live proxies</b> (each blocks Apply until accepted):
            {#each result.mismatches as m (m.id)}<label class="check"><input type="checkbox" bind:checked={accepted[m.id]} data-testid="import-accept-{m.id}" /> <span class="mono">{m.what}</span> {m.detail}</label>{/each}
          </div>
        {/if}
        {#if result.blockers.includes('unknown_proxy')}<p class="badge warn" data-testid="import-unknown-proxy">The file uses a proxy the registry doesn't know: tick "create proxies" or register it first.</p>{/if}
      </div>
    {/if}
    <h3>Export for cams's file mode</h3>
    <div class="row">{#each instances as i (i.id)}<button class="btn" data-testid="export-{i.name}" onclick={() => exportFile(i)}>Export for {i.name}</button>{/each}</div>
    <p class="muted">A <code>cameras.json</code> without passwords and tokens, plus the token ids the instance holds (docs/restore.md).</p>
  {/if}
  {#if error}<p class="error" data-testid="import-error">{error}</p>{/if}
</div>
{#if confirmApply && result}
  <Confirm title="Apply the import" body={`Into ${accountName}: ${summary.filter((s) => s.label !== 'proxies matched' && !s.label.startsWith('in the registry')).map((s) => `${s.count} ${s.label}`).join(', ')}. Nothing is deleted.`} ok="Apply" onconfirm={() => { confirmApply = false; run(true); }} oncancel={() => (confirmApply = false)} />
{/if}

<style>
  h3 { margin: 8px 0 0; font-size: 16px; }
  .check { display: flex; flex-direction: row; align-items: center; gap: 4px; color: var(--text); }
  .changes { margin: 0; padding-left: 18px; display: grid; gap: 2px; }
</style>
