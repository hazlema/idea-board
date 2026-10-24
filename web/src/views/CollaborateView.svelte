<script lang="ts">
  import Chat from '../components/Chat.svelte';
  import ConnectionsPanel from '../colab/ConnectionsPanel.svelte';
  import { chatPrefs } from '$lib/chatPrefs.svelte';
</script>

<!-- The chat's own tab. Popped out, it floats over every tab instead (ChatWindow). -->
<section class="flex min-w-0 flex-1 bg-panel" aria-label="Collaborate">
  {#if chatPrefs.popped}
    <div class="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 text-muted">
      <p>The chat is popped out.</p>
      <button type="button" class="rounded-md border border-line bg-raised px-3 py-1.5 text-text hover:border-muted" onclick={() => (chatPrefs.popped = false)}
        >Bring it back here</button
      >
    </div>
  {:else}
    <div class="mx-auto flex min-h-0 w-full max-w-5xl min-w-0 flex-1 flex-col">
      <Chat>
        {#snippet controls()}
          <button
            type="button"
            class="shrink-0 rounded-md border border-line px-2 py-0.5 text-text hover:border-muted"
            title="Float the chat over the board, so you can watch it change"
            onclick={() => (chatPrefs.popped = true)}>⧉ Pop out</button
          >
        {/snippet}
      </Chat>
    </div>
  {/if}
  <ConnectionsPanel />
</section>
