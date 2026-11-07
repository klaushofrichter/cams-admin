<script lang="ts">
  // Where a camera gets its power (PoE switch port, data only, adapter, unknown) and what can be done about it.
  // A check or a power-cycle answers 202; the outcome is read from GET power (lastCheck, lastCycle) every 2 s.
  import { api, errorText } from '../lib/api';
  import { clock } from '../lib/clock.svelte';
  import { flowDone, flowText, forceCycleText, poll, powerLine, type Flow, type Power } from '../lib/switches';
  import Confirm from './Confirm.svelte';

  let { camera, switches, canAct, onchanged }: { camera: any; switches: any[]; canAct: boolean; onchanged: () => void } = $props();
  const power = $derived(camera.power as Power | undefined);
  const sw = $derived(power && 'switchId' in power ? switches.find((s) => s.id === power.switchId) : undefined);
  let busy = $state(false);
  let result = $state('');
  let confirmForce = $state(false);
  const base = $derived(`/cameras/${camera.id}/power`);

  // Send, then wait for the flow `key` (lastCheck / lastCycle) to be new and finished.
  async function run(key: 'lastCheck' | 'lastCycle', send: () => Promise<any>) {
    busy = true;
    result = 'Sent, waiting for the proxy…';
    try {
      const prev = ((await api('GET', base)) as any)[key] as Flow | null;
      await send();
      const v = await poll(() => api<any>('GET', base), (x) => flowDone(prev, x[key]));
      result = v ? flowText(v[key]) : 'No answer yet: look again in a minute.';
      onchanged();
    } catch (e) {
      result = errorText(e);
    } finally { busy = false; }
  }
  const verify = () => run('lastCheck', () => api('POST', `${base}/verify`, {}));
  const find = () => run('lastCheck', () => api('PUT', base, { kind: 'auto' }));
  const cycle = () => run('lastCycle', () => api('POST', `${base}/cycle`, {}));
  const force = () => { confirmForce = false; return run('lastCycle', () => api('POST', `${base}/cycle`, { force: true })); };
  async function adapter() {
    busy = true;
    try { await api('PUT', base, { kind: 'adapter' }); result = ''; onchanged(); } catch (e) { result = errorText(e); } finally { busy = false; }
  }
</script>

<div class="power" data-testid="power-{camera.camsId}">
  <span data-testid="power-line-{camera.camsId}">{powerLine(power, sw?.name ?? null, clock.now)}</span>
  {#if canAct}
    <span class="row wrap">
      <button class="btn" data-testid="power-verify-{camera.camsId}" disabled={busy} onclick={verify}>Verify</button>
      <button class="btn" data-testid="power-find-{camera.camsId}" disabled={busy} onclick={find}>Find</button>
      <button class="btn" data-testid="power-adapter-{camera.camsId}" disabled={busy} onclick={adapter}>Declare adapter</button>
      {#if power?.kind === 'poe'}
        <button class="btn" data-testid="power-cycle-{camera.camsId}" disabled={busy} onclick={cycle}>Power-cycle</button>
        <button class="btn danger" data-testid="power-force-{camera.camsId}" disabled={busy} onclick={() => (confirmForce = true)}>Force power-cycle</button>
      {/if}
    </span>
  {/if}
  {#if result}<span class="mono small" data-testid="power-result-{camera.camsId}">{result}</span>{/if}
</div>
{#if confirmForce && power?.kind === 'poe'}
  <Confirm title="Force power-cycle" body={forceCycleText(sw?.name ?? 'the switch', power.port)} ok="Cut power" onconfirm={force} oncancel={() => (confirmForce = false)} />
{/if}

<style>
  .power { display: grid; gap: 4px; min-width: 12rem; }
  .wrap { flex-wrap: wrap; gap: 4px; }
  .small { font-size: 12px; }
</style>
