<script lang="ts">
  import { ago } from '../lib/format';
  import { clock } from '../lib/clock.svelte';
  let { t, testid = undefined }: { t: number | null; testid?: string } = $props();
</script>
<span data-testid={testid} title={t ? new Date(t).toLocaleString() : ''}>{ago(t, clock.now)}</span>
