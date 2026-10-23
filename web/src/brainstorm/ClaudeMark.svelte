<script lang="ts">
  // The dashed frame (in Claude's colour) on something Claude added, with Keep and Dismiss….
  // The parent must be positioned: the frame is drawn around it.
  import { authorColor, authorName } from '$lib/authors';
  import { live } from '$lib/live.svelte';
  import type { Author } from '$lib/types';

  interface Props {
    /** An object gets its buttons above the box; an entry gets them under its text. */
    variant: 'object' | 'entry';
    /** Who added it. */
    by: Author;
    onkeep: () => void;
    /** Called with the reason (possibly empty) once the user has answered "Why not?". */
    ondismiss: (reason: string) => void;
  }

  let { variant, by, onkeep, ondismiss }: Props = $props();

  function dismiss(): void {
    const reason = window.prompt('Why not?');
    if (reason === null) return;
    ondismiss(reason.trim());
  }
</script>

<div
  class="pointer-events-none absolute border-2 border-dashed border-claude/80 {variant === 'object' ? '-inset-[7px] rounded-[16px]' : 'inset-0 rounded-lg'}"
  aria-hidden="true"
></div>
<div class="flex flex-wrap items-center gap-1.5 {variant === 'object' ? 'absolute bottom-full left-0 mb-2.5 w-max rounded-md bg-ink/90 px-1.5 py-1 shadow' : 'mt-1.5'}">
  <span class="text-[11px] font-semibold whitespace-nowrap" style:color={authorColor(live.board, by)}><span aria-hidden="true">✦ </span><span>{authorName(live.board, by)} added</span></span>
  <button type="button" class="rounded-md border border-green-600 bg-green-600 px-2 py-px text-xs font-medium text-white hover:brightness-110" onclick={onkeep}>Keep</button>
  <button type="button" class="rounded-md border border-line bg-raised px-2 py-px text-xs hover:border-muted" onclick={dismiss}>Dismiss…</button>
</div>
