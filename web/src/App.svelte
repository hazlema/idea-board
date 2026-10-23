<script lang="ts">
  import { onMount } from 'svelte';
  import { live } from '$lib/live.svelte';
  import TopBar from './components/TopBar.svelte';
  import ChatDock from './components/ChatDock.svelte';
  import Toast from './components/Toast.svelte';
  import BrainstormView from './views/BrainstormView.svelte';
  import BriefView from './views/BriefView.svelte';
  import FlowchartView from './views/FlowchartView.svelte';

  onMount(() => live.connect());
</script>

<div class="flex h-full flex-col">
  <TopBar />

  <main class="flex min-h-0 flex-1">
    {#if live.board && live.view === 'brief'}
      <BriefView />
    {:else if live.board && live.view === 'brainstorm'}
      <BrainstormView />
    {:else if live.board && live.view === 'flowchart'}
      <FlowchartView />
    {:else}
      <section class="flex flex-1 flex-col items-center justify-center gap-1 text-muted" aria-label="Loading">
        <p>Connecting…</p>
      </section>
    {/if}
    <!-- Right panel (Memory) goes here once it exists. -->
    <aside class="empty:hidden"></aside>
  </main>

  <ChatDock />
  <Toast />
</div>
