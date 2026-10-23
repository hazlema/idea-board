<script lang="ts">
  import { whoName } from '$lib/format';
  import { live } from '$lib/live.svelte';

  const records = $derived([...(live.board?.ruledOut ?? [])].reverse());

  const day = (iso: string): string => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
</script>

<div class="flex flex-col gap-2">
  <p class="text-xs text-muted">Claude checks this list before suggesting anything, and won't bring these back unless you do.</p>

  {#each records as record (record.id)}
    <article class="rounded-lg border border-line bg-raised px-3 py-2">
      <div class="text-text line-through decoration-muted">{record.text}</div>
      {#if record.reason}
        <div class="mt-0.5 text-muted">“{record.reason}”</div>
      {/if}
      <div class="mt-1 flex items-center gap-2 text-xs text-muted">
        <span class="min-w-0 flex-1 truncate">{whoName(record.by)} · {day(record.at)} · {record.source.label}</span>
        <button
          type="button"
          class="shrink-0 rounded-md border border-line bg-panel px-2 py-px text-accent hover:border-accent"
          onclick={() => void live.send({ type: 'bringBack', id: record.id })}>Bring back</button>
      </div>
    </article>
  {:else}
    <p class="py-6 text-center text-muted">Nothing ruled out yet.</p>
  {/each}
</div>
