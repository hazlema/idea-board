<script lang="ts">
  import { onMount } from 'svelte';
  import { live } from '$lib/live.svelte';
  import TopBar from './components/TopBar.svelte';
  import ChatDock from './components/ChatDock.svelte';
  import Toast from './components/Toast.svelte';
  import BriefView from './views/BriefView.svelte';

  onMount(() => live.connect());

  const PLACEHOLDERS = {
    brainstorm: { name: 'Brainstorm', hint: 'Groups, notes and pictures go on this canvas.' },
    flowchart: { name: 'Flowchart', hint: 'Cards and connections go here.' },
  } as const;

  const placeholder = $derived(live.view === 'brief' ? null : PLACEHOLDERS[live.view]);
</script>

<div class="flex h-full flex-col">
  <TopBar />

  <main class="flex min-h-0 flex-1">
    {#if live.board && live.view === 'brief'}
      <BriefView />
    {:else}
      <section class="flex flex-1 flex-col items-center justify-center gap-1 text-muted" aria-label={placeholder?.name ?? 'Brief'}>
        {#if live.board && placeholder}
          <h2 class="text-lg font-semibold text-text">{placeholder.name}</h2>
          <p>{placeholder.hint}</p>
        {:else}
          <p>Connecting…</p>
        {/if}
      </section>
    {/if}
    <!-- Right panel (Memory) goes here once it exists. -->
    <aside class="empty:hidden"></aside>
  </main>

  <ChatDock />
  <Toast />
</div>
