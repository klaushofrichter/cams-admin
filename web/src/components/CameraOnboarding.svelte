<script lang="ts">
  // One camera's onboarding (cam-proxy onboarding design §5), on the proxy page's camera focus: the proxy's
  // steps, the registry row, each viewer's state and what is still missing. "Refresh status" asks the proxy for
  // the full status (camera.onboarding.get); "Set time" and "FTP setup" are the camera actions camera-time-set
  // and camera-ftp-setup, each only when the proxy allows it, with the action's name typed back.
  import { api, errorText } from '../lib/api';
  import { EFFECT, stateLine, waitCommand } from '../lib/config';
  import { missingText, stepLabel, viewerLine, type ViewerState } from '../lib/onboarding';
  import { when } from '../lib/format';
  import Confirm from './Confirm.svelte';

  let { accountId, proxyId, camera, refresh }: { accountId: string; proxyId: string; camera: string; refresh: number } = $props();
  const base = $derived(`/accounts/${accountId}/proxies/${proxyId}`);

  let v = $state<any>(null);
  let error = $state('');
  let result = $state('');
  let busy = $state(false);
  let confirm = $state<string | null>(null);

  async function load() {
    try { v = await api('GET', `${base}/cameras/${encodeURIComponent(camera)}/onboarding`); error = ''; } catch (e) { error = errorText(e); }
  }
  $effect(() => { void refresh; void camera; load(); });

  // The proxy's step list: the newest full status when there is one, else the heartbeat's compact one.
  const steps = $derived.by(() => {
    const full = v?.detail?.result?.steps;
    if (full && typeof full === 'object') return Object.entries(full).map(([k, s]: [string, any]) => ({ step: k, ok: s?.ok ?? null, detail: s?.detail ?? '', action: s?.action ?? null }));
    return (v?.reported?.missing ?? []).map((k: string) => ({ step: k, ok: false, detail: '', action: null }));
  });

  async function run(label: string, send: () => Promise<{ commandId: string }>) {
    busy = true;
    result = `${label}: sent, waiting for the proxy`;
    try {
      const r = await send();
      const done = await waitCommand(() => api('GET', `${base}/commands/${r.commandId}`));
      const res = done?.result ?? {};
      result = !done ? `${label}: no answer from the proxy yet`
        : `${label}: ${done.state === 'done' ? 'done' : stateLine(done)}${res.verified === true ? ' · verified ✓' : ''}${Array.isArray(res.mismatch) && res.mismatch.length ? ` · mismatch: ${res.mismatch.join(', ')}` : ''}`;
      await load();
    } catch (e) {
      result = `${label}: ${errorText(e)}`;
    } finally {
      busy = false;
    }
  }
  const refreshStatus = () => run('Refresh status', () => api('POST', `${base}/cameras/${encodeURIComponent(camera)}/onboarding/refresh`, {}));
  function confirmed() {
    const a = confirm;
    confirm = null;
    if (a) run(a, () => api('POST', `${base}/actions`, { camera, action: a, confirm: a }));
  }
  async function adopt() {
    try { await api('POST', `${base}/adopt`, { proxyCameraId: camera, kind: 'camera' }); await load(); } catch (e) { error = errorText(e); }
  }
  const allowed = $derived(v?.proxy?.onboardingAllowed ?? { get: false, ftpSetup: false, timeSet: false });
</script>

<section class="card grid" data-testid="camera-onboarding">
  <div class="row">
    <h3>Onboarding <span class="mono">{camera}</span></h3>
    {#if v}<span class="chip {v.ready ? 'ok' : 'bad'}" data-testid="onboarding-ready">{v.ready ? 'ready' : 'not ready'}</span>{/if}
  </div>
  {#if error}<p class="error" data-testid="onboarding-error">{error}</p>{/if}
  {#if v}
    <div class="grid">
      <b>Proxy</b>
      {#if v.detail}<p class="muted small" data-testid="onboarding-checked">full status {v.detail.state === 'done' ? `from ${when(v.detail.finishedAt)}` : stateLine(v.detail)}</p>{/if}
      {#if steps.length}
        <table data-testid="onboarding-steps">
          <tbody>
            {#each steps as s (s.step)}
              <tr data-testid="onboarding-step-{s.step}"><td>{stepLabel(s.step)}</td><td>{s.ok === true ? '✓' : s.ok === false ? '✗' : '?'}</td><td class="muted">{s.detail}</td></tr>
            {/each}
          </tbody>
        </table>
      {:else if v.reported}
        <p class="muted">Every step done.</p>
      {:else}
        <p class="muted">The proxy reports no onboarding status for this camera.</p>
      {/if}
    </div>
    <div class="grid">
      <b>Account</b>
      {#if v.camera}
        <p data-testid="onboarding-registry"><span class="mono">{v.camera.camsId}</span> · {v.camera.name}{v.camera.model ? ` · ${v.camera.model}` : ''} · host <span class="mono">{v.camera.host ?? '—'}</span></p>
      {:else}
        <div class="row"><span class="muted">Not in the account yet</span><button class="btn" data-testid="onboarding-adopt" onclick={adopt}>Add to account</button></div>
      {/if}
    </div>
    <div class="grid">
      <b>Viewers</b>
      {#each v.viewers as w (w.instanceId)}
        <div class="row" data-testid="onboarding-viewer-{w.name}"><span>{w.name}</span><span class="muted">{viewerLine(w as ViewerState)}</span>
          {#each w.problems as p}<span class="badge bad">{p.code}{p.detail ? `: ${p.detail}` : ''}</span>{/each}</div>
      {:else}
        <p class="muted">No viewer serves this account.</p>
      {/each}
    </div>
    {#if v.missing.length}
      <ul data-testid="onboarding-missing">{#each v.missing as m}<li>{missingText(m)}</li>{/each}</ul>
    {/if}
    {#if v.optional?.length}<p class="muted small" data-testid="onboarding-optional">Optional, not done: {v.optional.map(missingText).join(' · ')}</p>{/if}
    <div class="row wrap">
      <button class="btn" data-testid="onboarding-refresh" disabled={!allowed.get || busy} title={allowed.get ? '' : 'not allowed on the proxy'} onclick={refreshStatus}>Refresh status</button>
      <button class="btn danger" data-testid="onboarding-time-set" disabled={!allowed.timeSet || busy} title={allowed.timeSet ? '' : 'not allowed on the proxy'} onclick={() => (confirm = 'camera-time-set')}>Set time</button>
      <button class="btn danger" data-testid="onboarding-ftp-setup" disabled={!allowed.ftpSetup || busy} title={allowed.ftpSetup ? '' : 'not allowed on the proxy'} onclick={() => (confirm = 'camera-ftp-setup')}>FTP setup</button>
    </div>
    {#if result}<p class="mono small" data-testid="onboarding-result">{result}</p>{/if}
  {:else if !error}
    <p class="muted">Loading…</p>
  {/if}
</section>

{#if confirm}
  <Confirm title={`${confirm} on ${camera}`} body={EFFECT[confirm] ?? ''} typed={confirm} ok="Run" onconfirm={confirmed} oncancel={() => (confirm = null)} />
{/if}

<style>
  h3 { margin: 0; }
  .wrap { flex-wrap: wrap; gap: 6px; }
  .small { font-size: 12px; margin: 0; }
  ul { margin: 0; padding-left: 20px; }
</style>
