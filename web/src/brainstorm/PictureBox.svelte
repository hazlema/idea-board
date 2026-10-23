<script lang="ts" module>
  import * as api from '$lib/api';
  import { live } from '$lib/live.svelte';
  import { makePreview } from '$lib/pictures';

  // Pictures whose preview has been made (or tried) since the page loaded, so it happens once.
  // Bookkeeping only: nothing on screen depends on it.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const previewed = new Set<string>();

  /** Makes the smaller copy Claude looks at, uploads it, and records it on the picture. */
  export async function attachPreview(id: string, blob: Blob): Promise<void> {
    if (previewed.has(id)) return;
    previewed.add(id);
    try {
      const preview = await api.uploadPicture(await makePreview(blob));
      await live.send({ type: 'setPicturePreview', id, preview });
    } catch (error) {
      live.toast(error instanceof Error ? error.message : 'Could not make a preview of the picture');
    }
  }

  async function previewFromAsset(id: string, asset: string): Promise<void> {
    if (previewed.has(id)) return;
    let blob: Blob;
    try {
      const res = await fetch(`/assets/${encodeURIComponent(asset)}`);
      if (!res.ok) throw new Error(`Could not load the picture (${res.status})`);
      blob = await res.blob();
    } catch (error) {
      previewed.add(id);
      live.toast(error instanceof Error ? error.message : 'Could not load the picture');
      return;
    }
    await attachPreview(id, blob);
  }
</script>

<script lang="ts">
  import { autogrow, drag as dragAction, resize as resizeAction, type DragOptions, type ResizeOptions } from '$lib/actions';
  import { Draft } from '$lib/draft.svelte';
  import { findObject, type Picture } from '$lib/types';

  interface Props {
    picture: Picture;
    drag?: DragOptions;
    resize?: ResizeOptions;
    /** Shown from a saved version: nothing is sent to the board. */
    readonly?: boolean;
  }

  let { picture, drag, resize, readonly = false }: Props = $props();

  const caption = new Draft({
    server: () => picture.caption,
    save: (v) => (findObject(live.board, picture.id) ? live.send({ type: 'updateObject', id: picture.id, caption: v }) : Promise.resolve({})),
    delay: 500,
  });

  // A picture that arrived without a preview (from a URL, or from Claude) gets one the first time it is shown.
  $effect(() => {
    if (!readonly && !picture.preview) void previewFromAsset(picture.id, picture.asset);
  });
</script>

<!-- Dragged by the picture itself or the frame around it. -->
<div use:dragAction={drag} class="relative flex grow cursor-grab flex-col rounded-xl border border-line bg-panel p-2 shadow-lg active:cursor-grabbing">
  <div class="px-0.5 pb-1.5 text-xs text-muted select-none" aria-hidden="true">⠿</div>
  <img src="/assets/{picture.asset}" alt={picture.caption || 'Picture'} draggable="false" class="block h-auto w-full rounded-md bg-ink select-none" />
  <textarea
    rows="1"
    maxlength="500"
    placeholder="Add a caption"
    aria-label="Caption"
    class="mt-1.5 block w-full cursor-text resize-none overflow-hidden rounded-sm bg-transparent px-0.5 text-[12.5px] leading-[1.45] text-muted outline-none focus:bg-ink/50 focus:text-text"
    use:autogrow={caption.shown}
    {...caption.attrs}
  ></textarea>

  {#if resize}
    <div use:resizeAction={resize} data-no-drag class="absolute right-0 bottom-0 size-4 cursor-nwse-resize text-muted" title="Drag to resize" aria-hidden="true">
      <svg viewBox="0 0 16 16" class="size-full"><path d="M12 6 6 12M12 10l-2 2" stroke="currentColor" stroke-width="1.3" fill="none" /></svg>
    </div>
  {/if}
</div>
