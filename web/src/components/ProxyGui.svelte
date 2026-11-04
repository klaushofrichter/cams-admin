<script lang="ts">
  import { addressInfo, addressMarker } from '../lib/address';
  let { address, testid }: { address: string | null | undefined; testid: string } = $props();
  const info = $derived(addressInfo(address));
  const marker = $derived(addressMarker(info.scope));
</script>
<!-- A proxy's GUI address: a link opening in a new tab, with its reach marked. -->
{#if info.href}
  <span class="gui">
    <a class="mono" href={info.href} title={info.warning ?? undefined} target="_blank" rel="noopener noreferrer" data-testid={testid}>{address}</a>
    {#if marker}<span class="badge warn" title={info.warning ?? undefined} data-testid="{testid}-marker">{marker}</span>{/if}
  </span>
{:else if address}
  <span class="mono" data-testid={testid}>{address}</span>
{:else}
  <span class="muted" data-testid={testid}>–</span>
{/if}

<style>
  .gui { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; min-width: 0; }
</style>
