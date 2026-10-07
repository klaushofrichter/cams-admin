<script lang="ts">
  // P4: import cams's redacted export into this account (dry run first), and
  // export a cameras.json for cams's file mode, per cams instance.
  import { onMount } from 'svelte';
  import { api, errorText } from '../lib/api';
  import { describeChange, importSummary } from '../lib/cams';
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
      // No default: the instance is always picked (a Pi export once nearly went to the cluster).
      instanceId = '';
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
        // Apply is bound to the dry run shown (same plan, once, 10 minutes).
        ...(apply ? { planId: result?.planId } : {}),
      });
    } catch (e: any) {
      error = e?.code === 'plan_changed' ? 'Something changed since the dry run: run it again and check the changes.' : e?.code === 'plan_expired' ? 'The dry run is too old (10 minutes) or was used: run it again.' : errorText(e);
      if (apply) result = null;
    }
    busy = false;
  }
  // Any option changed after a dry run: its plan no longer applies.
  const reset = () => { result = null; };

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

  const summary = $derived(result ? importSummary(result) : []);
  const allAccepted = $derived(!!result && result.mismatches.every((m: any) => accepted[m.id]));
  const instanceName = $derived(instances.find((i) => i.id === instanceId)?.name ?? '');
  // The file looks like another instance's export: shown on its own, confirmed on its own.
  const otherInstance = $derived(result ? result.mismatches.filter((m: any) => m.what === 'other-instance') : []);
  const liveMismatches = $derived(result ? result.mismatches.filter((m: any) => m.what !== 'other-instance') : []);
  const confirmInstance = (on: boolean) => { for (const m of otherInstance) accepted[m.id] = on; };
</script>

<div class="grid" data-testid="import-panel">
  {#if !instances.length}
    <p class="muted">No cams instance serves this account yet (<a href="#/cams-instances">cams instances</a>).</p>
  {:else}
    <div class="row">
      <label>cams instance<select bind:value={instanceId} data-testid="import-instance" onchange={() => (result = null)}><option value="" disabled>— pick the instance this export is from —</option>{#each instances as i (i.id)}<option value={i.id}>{i.name}</option>{/each}</select></label>
      <label>Export of cams (<code>export-config</code>)<input type="file" accept="application/json,.json" onchange={pick} data-testid="import-file" /></label>
      {#if fileInfo}<span class="muted" data-testid="import-file-info">{fileInfo}</span>{/if}
    </div>
    <div class="row">
      <label class="check"><input type="checkbox" bind:checked={createProxies} onchange={reset} data-testid="import-create-proxies" /> create proxies the registry doesn't know</label>
      <label class="check"><input type="checkbox" bind:checked={hideUnlisted} onchange={reset} data-testid="import-hide-unlisted" /> hide proxies this file doesn't use (for this instance)</label>
    </div>
    <div class="row">
      <button class="btn" data-testid="import-dry-run" disabled={!file || !instanceId || busy} onclick={() => run(false)}>Dry run</button>
      {#if result && !result.noChanges}<button class="btn primary" data-testid="import-apply" disabled={busy || result.blockers.some((b: string) => b !== 'unknown_proxy' || !createProxies) || !allAccepted} onclick={() => (confirmApply = true)}>Apply</button>{/if}
    </div>
    {#if result}
      <div class="grid" data-testid="import-result">
        {#if otherInstance.length}
          <div class="other" role="alert" data-testid="import-other-instance">
            <b>Is this {result.looksLike?.length ? `${result.looksLike.join(', ')}'s` : "another instance's"} export? You picked {result.instance}.</b>
            {#each otherInstance as m (m.id)}<div>{m.detail}</div>{/each}
            <label class="check"><input type="checkbox" checked={otherInstance.every((m: any) => accepted[m.id])} onchange={(e) => confirmInstance((e.target as HTMLInputElement).checked)} data-testid="import-confirm-instance" /> Yes, this file is the export of {result.instance}'s cams</label>
          </div>
        {/if}
        {#if result.noChanges}<p data-testid="import-no-changes"><b>No changes.</b> The registry already matches this file.</p>
        {:else if result.applied}<p data-testid="import-applied"><b>Applied.</b></p>{/if}
        <div class="row">{#each summary as s}<span class="badge" data-testid="import-count">{s.count} {s.label}</span>{/each}</div>
        <ul class="changes">{#each result.changes as c}<li class="mono" data-testid="import-change">{describeChange(c)}</li>{/each}</ul>
        {#if liveMismatches.length}
          <div data-testid="import-mismatches"><b>Mismatches with the live proxies</b> (each blocks Apply until accepted):
            {#each liveMismatches as m (m.id)}<label class="check"><input type="checkbox" bind:checked={accepted[m.id]} data-testid="import-accept-{m.id}" /> <span class="mono">{m.what}</span> {m.detail}</label>{/each}
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
  <Confirm title="Apply the import" body={`Into ${accountName}, for cams instance ${instanceName}: ${summary.filter((s) => s.label !== 'proxies matched' && !s.label.startsWith('in the registry')).map((s) => `${s.count} ${s.label}`).join(', ')}. Nothing is deleted.`} ok="Apply" onconfirm={() => { confirmApply = false; run(true); }} oncancel={() => (confirmApply = false)} />
{/if}

<style>
  h3 { margin: 8px 0 0; font-size: 16px; }
  .check { display: flex; flex-direction: row; align-items: center; gap: 4px; color: var(--text); }
  .other { border: 2px solid var(--danger); border-radius: 8px; padding: 8px 10px; display: grid; gap: 4px; }
  .changes { margin: 0; padding-left: 18px; display: grid; gap: 2px; }
</style>
