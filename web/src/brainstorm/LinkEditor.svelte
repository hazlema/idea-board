<script lang="ts">
  // The small box under a selected link: label, dashed, delete. One per link
  // (keyed by id), so a label still being typed is saved to its own link when
  // the selection moves on.
  import { untrack } from 'svelte';
  import { Draft } from '$lib/draft.svelte';
  import type { Point } from '$lib/geometry';
  import { live } from '$lib/live.svelte';
  import type { BLink } from '$lib/types';

  interface Props {
    link: BLink;
    /** The middle of the curve, in world coordinates. */
    at: Point;
    ondelete: (id: string) => void;
  }

  let { link, at, ondelete }: Props = $props();

  // Fixed for the life of the editor (it is keyed by link id), and still right after it is gone.
  const id = untrack(() => link.id);
  const exists = () => live.board?.brainstorm.pages.some((p) => p.links.some((l) => l.id === id)) ?? false;

  const label = new Draft({
    server: () => link.label,
    save: (v) => (exists() ? live.send({ type: 'updateLink', id, label: v }) : Promise.resolve({})),
    delay: 400,
  });
</script>

<div
  data-nopan
  role="group"
  aria-label="Link details"
  class="absolute z-30 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-line bg-panel px-2 py-1.5 text-sm shadow-lg"
  style:left="{at.x}px"
  style:top="{at.y + 14}px"
>
  <input
    type="text"
    maxlength="200"
    placeholder="Label"
    aria-label="Link label"
    class="w-32 rounded-md border border-line bg-ink px-2 py-0.5"
    {...label.attrs}
    onkeydown={(e) => {
      if (e.key === 'Enter' && !e.isComposing) e.currentTarget.blur();
    }}
  />
  <label class="flex items-center gap-1 text-muted select-none">
    <input
      type="checkbox"
      checked={link.dashed}
      onclick={(e) => {
        // The board, not the click, decides what the box shows.
        e.preventDefault();
        void live.send({ type: 'updateLink', id, dashed: !link.dashed });
      }}
    /> Dashed
  </label>
  <button type="button" class="rounded-md border border-line px-2 py-0.5 text-rose-400 hover:border-rose-400" onclick={() => ondelete(id)}>Delete</button>
</div>
