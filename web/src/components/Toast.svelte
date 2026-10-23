<script lang="ts">
  import { live } from '$lib/live.svelte';
</script>

<div class="pointer-events-none fixed right-4 top-14 z-50 flex w-80 flex-col gap-2" aria-live="polite">
  {#each live.toasts as toast (toast.id)}
    <div class="pointer-events-auto flex items-start gap-2 rounded-md border border-line bg-raised px-3 py-2 shadow-lg" role="status">
      <span class="flex-1 break-words">{toast.text}</span>
      <button class="text-muted hover:text-text" aria-label="Dismiss" onclick={() => live.dismissToast(toast.id)}>×</button>
    </div>
  {/each}
</div>
