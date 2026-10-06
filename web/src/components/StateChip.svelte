<script lang="ts">
  import { stateClass, stateLabel } from '../lib/format';
  let { state, testid = undefined }: { state: string; testid?: string } = $props();
</script>
<span class="chip {stateClass(state)}" data-testid={testid} data-state={state}>{stateLabel(state)}</span>
