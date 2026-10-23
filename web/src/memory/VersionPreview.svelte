<script lang="ts">
  import { live } from '$lib/live.svelte';
  import BrainstormView from '../views/BrainstormView.svelte';
  import BriefView from '../views/BriefView.svelte';
  import FlowchartView from '../views/FlowchartView.svelte';
  import { preview, restoreVersion } from './preview.svelte';

  // The saved content over today's board: the parts a version does not hold (memory, chat) stay as they are.
  const board = $derived(preview.current && live.board ? { ...live.board, ...preview.current.content } : null);
</script>

{#if preview.current && board}
    {@const meta = preview.current.meta}
  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
    <div class="flex items-center gap-3 border-b border-accent/50 bg-accent/15 px-4 py-2" role="status">
      <span class="font-medium">Previewing “{meta.name}”</span>
      <span class="text-xs text-muted">Read-only</span>
      <div class="ml-auto flex gap-2">
        <button type="button" class="rounded-md bg-accent px-2.5 py-1 font-medium text-ink hover:brightness-110" onclick={() => void restoreVersion(meta)}>Restore</button>
        <button type="button" class="rounded-md border border-line bg-raised px-2.5 py-1 hover:border-muted" onclick={() => preview.close()}>Close</button>
      </div>
    </div>
    {#if live.view === 'brief'}
      <BriefView {board} />
    {:else if live.view === 'brainstorm'}
      <BrainstormView {board} />
    {:else}
      <FlowchartView {board} />
    {/if}
  </div>
{/if}
