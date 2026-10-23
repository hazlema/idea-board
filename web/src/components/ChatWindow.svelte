<script lang="ts" module>
  import type { Rect } from '$lib/chatPrefs.svelte';

  /** Where a window that has never been moved goes: the bottom-right corner. */
  export function defaultWindow(screen: { w: number; h: number }): Rect {
    const w = 440;
    const h = 520;
    return { x: screen.w - w - 24, y: screen.h - h - 24, w, h };
  }
</script>

<script lang="ts">
  import Chat from './Chat.svelte';
  import { drag, resize } from '$lib/actions';
  import { chatPrefs, fitWindow, MIN_WINDOW } from '$lib/chatPrefs.svelte';

  const screenSize = () => ({ w: window.innerWidth, h: window.innerHeight });

  // Follows the pointer while dragging or resizing; saved when the pointer lets go.
  let rect = $state(fitWindow(chatPrefs.window ?? defaultWindow(screenSize()), screenSize()));

  function place(next: Rect, save: boolean): void {
    rect = fitWindow(next, screenSize());
    if (save) chatPrefs.window = rect;
  }
</script>

<!-- A shrunken browser window pulls the chat back into view. -->
<svelte:window onresize={() => place(rect, false)} />

<div
  class="fixed z-40 flex flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
  style:left="{rect.x}px"
  style:top="{rect.y}px"
  style:width="{rect.w}px"
  style:height="{rect.h}px"
  role="dialog"
  aria-label="Chat window"
>
  <header
    class="flex cursor-grab items-center gap-2 border-b border-line bg-raised px-3 py-1.5 text-sm select-none active:cursor-grabbing"
    use:drag={{
      getStart: () => ({ x: rect.x, y: rect.y }),
      scale: () => 1,
      onMove: (x, y) => place({ ...rect, x, y }, false),
      onEnd: (x, y) => place({ ...rect, x, y }, true),
    }}
  >
    <span class="text-muted" aria-hidden="true">⠿</span>
    <span class="flex-1 font-medium">Chat with Claude</span>
    <button type="button" class="px-1 text-muted hover:text-text" aria-label="Close the chat window" title="Close (the chat stays in the Collaborate tab)" onclick={() => (chatPrefs.popped = false)}
      >✕</button
    >
  </header>
  <Chat />
  <div
    class="absolute right-0 bottom-0 size-4 cursor-nwse-resize text-muted"
    title="Drag to resize"
    aria-hidden="true"
    use:resize={{
      min: MIN_WINDOW,
      scale: () => 1,
      onMove: (w, h) => place({ ...rect, w, h }, false),
      onEnd: (w, h) => place({ ...rect, w, h }, true),
    }}
  >
    <svg viewBox="0 0 16 16" class="size-full"><path d="M12 6 6 12M12 10l-2 2" stroke="currentColor" stroke-width="1.3" fill="none" /></svg>
  </div>
</div>
