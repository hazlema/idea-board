<script lang="ts">
  import { onMount } from 'svelte';
  import { chatPrefs } from '$lib/chatPrefs.svelte';
  import { live } from '$lib/live.svelte';
  import TopBar from './components/TopBar.svelte';
  import ChatWindow from './components/ChatWindow.svelte';
  import RequestDialog from './components/RequestDialog.svelte';
  import Toast from './components/Toast.svelte';
  import MemoryPanel from './memory/MemoryPanel.svelte';
  import { preview } from './memory/preview.svelte';
  import VersionPreview from './memory/VersionPreview.svelte';
  import BrainstormView from './views/BrainstormView.svelte';
  import BriefView from './views/BriefView.svelte';
  import CollaborateView from './views/CollaborateView.svelte';
  import FlowchartView from './views/FlowchartView.svelte';

  // The flowchart shows a card's or arrow's details on the right; then the Memory panel gives way.
  // The Collaborate tab gives the chat the whole width.
  let flowSelection = $state(false);
  const showMemory = $derived(
    Boolean(live.board) && live.view !== 'collaborate' && (live.view !== 'flowchart' || Boolean(preview.current) || !flowSelection),
  );

  onMount(() => live.connect());
</script>

<div class="flex h-full flex-col">
  <TopBar />

  <main class="flex min-h-0 flex-1">
    {#if live.board && live.view === 'collaborate'}
      <CollaborateView />
    {:else if live.board && preview.current}
      <VersionPreview />
    {:else if live.board && live.view === 'brief'}
      <BriefView />
    {:else if live.board && live.view === 'brainstorm'}
      <BrainstormView />
    {:else if live.board && live.view === 'flowchart'}
      <FlowchartView onselection={(has) => (flowSelection = has)} />
    {:else}
      <section class="flex flex-1 flex-col items-center justify-center gap-1 text-muted" aria-label="Loading">
        <p>Connecting…</p>
      </section>
    {/if}
    {#if showMemory}
      <MemoryPanel />
    {/if}
  </main>

  {#if live.board && chatPrefs.popped}
    <ChatWindow />
  {/if}
  <RequestDialog />
  <Toast />
</div>
