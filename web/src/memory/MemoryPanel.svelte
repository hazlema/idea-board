<script lang="ts">
  import { live } from '$lib/live.svelte';
  import HistoryList from './HistoryList.svelte';
  import RuledOutList from './RuledOutList.svelte';

  type Tab = 'ruled-out' | 'history';

  let tab = $state<Tab>('ruled-out');

  const ruledOut = $derived(live.board?.ruledOut.length ?? 0);
  const tabClass = (t: Tab): string => `rounded-md px-2.5 py-1 ${tab === t ? 'bg-accent/25 text-text' : 'text-muted hover:text-text'}`;
</script>

<aside class="flex w-[320px] shrink-0 flex-col border-l border-line bg-panel" aria-label="Memory">
  <header class="px-4 pt-4 pb-2">
    <h2 class="text-base font-semibold">Memory</h2>
    <div class="mt-2 flex gap-1" role="tablist" aria-label="Memory">
      <button type="button" role="tab" aria-selected={tab === 'ruled-out'} class={tabClass('ruled-out')} onclick={() => (tab = 'ruled-out')}>Ruled out ({ruledOut})</button>
      <button type="button" role="tab" aria-selected={tab === 'history'} class={tabClass('history')} onclick={() => (tab = 'history')}>History</button>
    </div>
  </header>
  <div class="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-4" role="tabpanel">
    {#if tab === 'ruled-out'}
      <RuledOutList />
    {:else}
      <HistoryList />
    {/if}
  </div>
</aside>
