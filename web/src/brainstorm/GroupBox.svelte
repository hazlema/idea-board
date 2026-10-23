<script lang="ts" module>
  import type { Color } from '$lib/types';

  export const COLORS: Color[] = ['slate', 'violet', 'green', 'amber', 'rose', 'sky'];
  /** The colour behind each group's dot, header band and tint. */
  export const TINTS: Record<Color, string> = {
    slate: '#94a3b8',
    violet: '#8b5cf6',
    green: '#22c55e',
    amber: '#f59e0b',
    rose: '#f43f5e',
    sky: '#0ea5e9',
  };
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import EntryRow, { entryDrop } from './EntryRow.svelte';
  import { drag as dragAction, outside, resize as resizeAction, type DragOptions, type ResizeOptions } from '$lib/actions';
  import { Draft } from '$lib/draft.svelte';
  import { live } from '$lib/live.svelte';
  import { findObject, type Entry, type Group } from '$lib/types';

  interface Props {
    group: Group;
    /** Dragging by the title bar. */
    drag?: DragOptions;
    /** Resizing from the bottom-right grip. */
    resize?: ResizeOptions;
    /** Focus and select the title (a new group). */
    autofocus?: boolean;
    onfocused?: () => void;
    /** The ⋯ menu's Delete; the view confirms and deletes. */
    ondelete?: () => void;
  }

  let { group, drag, resize, autofocus = false, onfocused, ondelete }: Props = $props();

  let root: HTMLDivElement | undefined = $state();
  let titleInput: HTMLInputElement | undefined = $state();
  let menuOpen = $state(false);
  let adding = $state(false);
  let newLabel = $state('');
  let focusEntry = $state<string | null>(null);

  const title = new Draft({
    server: () => group.title,
    save: (v) => (findObject(live.board, group.id) ? live.send({ type: 'updateObject', id: group.id, title: v }) : Promise.resolve({})),
    delay: 400,
  });

  const shownEntries = $derived(group.entries.filter((e) => !e.ruledOut));
  const ruledEntries = $derived(group.entries.filter((e) => e.ruledOut));
  const dropAtEnd = $derived(entryDrop.dragging !== null && entryDrop.groupId === group.id && entryDrop.entryId === null);

  const recordFor = (entry: Entry) => live.board?.ruledOut.find((r) => r.source.entryId === entry.id);

  $effect(() => {
    if (!autofocus || !titleInput) return;
    titleInput.focus();
    titleInput.select();
    onfocused?.();
  });

  // A new entry arrives with the board update; then its text takes the cursor.
  $effect(() => {
    const id = focusEntry;
    if (!id || !group.entries.some((e) => e.id === id)) return;
    focusEntry = null;
    void tick().then(() => root?.querySelector<HTMLTextAreaElement>(`[data-entry-id="${id}"] textarea`)?.focus());
  });

  function recolor(color: Color): void {
    menuOpen = false;
    if (color !== group.color) void live.send({ type: 'updateObject', id: group.id, color });
  }

  async function startAdding(): Promise<void> {
    adding = true;
    newLabel = '';
    await tick();
    root?.querySelector<HTMLInputElement>('[data-new-entry]')?.focus();
  }

  async function commitNew(): Promise<void> {
    if (!adding) return;
    adding = false;
    const label = newLabel.trim();
    newLabel = '';
    if (!label) return;
    const result = (await live.send({ type: 'addEntry', groupId: group.id, label, text: '' })) as { entry?: Entry } | null;
    if (result?.entry) focusEntry = result.entry.id;
  }

  function newKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      void commitNew();
    } else if (event.key === 'Escape') {
      adding = false;
      newLabel = '';
    }
  }
</script>

<div
  bind:this={root}
  data-group-id={group.id}
  class="gbox relative flex flex-1 flex-col rounded-xl border shadow-lg {dropAtEnd ? 'outline-2 outline-dashed outline-accent' : ''}"
  style:--tint={TINTS[group.color]}
>
  <header use:dragAction={drag} class="ghead flex cursor-grab items-center gap-2 rounded-t-xl border-b px-3 pt-2 pb-1.5 select-none active:cursor-grabbing">
    <span class="size-2.5 shrink-0 rounded-full" style:background="var(--tint)" aria-hidden="true"></span>
    <input
      bind:this={titleInput}
      type="text"
      maxlength="200"
      placeholder="Untitled group"
      aria-label="Group title"
      size={Math.max(4, title.shown.length)}
      class="field-sizing-content max-w-full min-w-[4ch] rounded-sm bg-transparent p-0 text-[15px] font-bold outline-none focus:bg-ink/50"
      {...title.attrs}
      onkeydown={(e) => {
        if (e.key === 'Enter' && !e.isComposing) e.currentTarget.blur();
      }}
    />
    <span class="flex-1"></span>
    <div class="relative" use:outside={() => (menuOpen = false)}>
      <button
        type="button"
        class="px-1 leading-none text-muted hover:text-text"
        aria-label="Group menu"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onclick={() => (menuOpen = !menuOpen)}>⋯</button
      >
      {#if menuOpen}
        <div role="menu" class="absolute top-full right-0 z-30 mt-1 w-44 rounded-md border border-line bg-panel py-1.5 text-sm shadow-lg">
          <div class="flex gap-1.5 px-3 pb-1.5">
            {#each COLORS as color (color)}
              <button
                type="button"
                role="menuitem"
                aria-label={color}
                title={color}
                class="size-5 rounded-full border-2 {color === group.color ? 'border-text' : 'border-transparent'}"
                style:background={TINTS[color]}
                onclick={() => recolor(color)}
              ></button>
            {/each}
          </div>
          <button
            type="button"
            role="menuitem"
            class="block w-full border-t border-line px-3 pt-1.5 pb-0.5 text-left text-rose-400 hover:bg-raised"
            onclick={() => {
              menuOpen = false;
              ondelete?.();
            }}>Delete</button
          >
        </div>
      {/if}
    </div>
  </header>

  <ul class="m-0 flex list-none flex-col gap-[7px] px-3 pt-2 pb-1 empty:hidden">
    {#each shownEntries as entry (entry.id)}
      <EntryRow {group} {entry} />
    {/each}
    {#if adding}
      <li class="flex items-start gap-2">
        <span class="w-[13px] shrink-0 text-center text-muted" aria-hidden="true">•</span>
        <input
          data-new-entry
          type="text"
          maxlength="200"
          placeholder="Label"
          aria-label="New item label"
          class="min-w-0 flex-1 rounded-sm bg-ink/50 p-0 leading-[1.45] font-semibold outline-none"
          bind:value={newLabel}
          onkeydown={newKeydown}
          onblur={commitNew}
        />
      </li>
    {/if}
  </ul>
  <button type="button" class="self-start px-3 pt-0.5 pb-2.5 pl-[33px] text-[13px] text-muted hover:text-text" onclick={startAdding}>+ add item</button>

  {#if ruledEntries.length}
    <details class="mx-3 mb-2.5 text-[12.5px] text-muted">
      <summary class="cursor-pointer select-none">{ruledEntries.length} ruled out</summary>
      <ul class="m-0 mt-1 flex list-none flex-col gap-1 pl-5">
        {#each ruledEntries as entry (entry.id)}
          {@const record = recordFor(entry)}
          <li class="flex items-baseline gap-2">
            <span class="min-w-0 flex-1 line-through" title={record?.reason ? `Why not: ${record.reason}` : undefined}>{entry.label}</span>
            {#if record}
              <button type="button" class="shrink-0 text-accent hover:underline" onclick={() => void live.send({ type: 'bringBack', id: record.id })}>Bring back</button>
            {/if}
          </li>
        {/each}
      </ul>
    </details>
  {/if}

  {#if resize}
    <div use:resizeAction={resize} data-no-drag class="absolute right-0 bottom-0 size-4 cursor-nwse-resize rounded-br-xl text-muted" title="Drag to resize" aria-hidden="true">
      <svg viewBox="0 0 16 16" class="size-full"><path d="M12 6 6 12M12 10l-2 2" stroke="currentColor" stroke-width="1.3" fill="none" /></svg>
    </div>
  {/if}
</div>

<style>
  .gbox {
    background: color-mix(in srgb, var(--tint) 8%, var(--color-panel));
    border-color: color-mix(in srgb, var(--tint) 32%, var(--color-line));
  }

  .ghead {
    background: color-mix(in srgb, var(--tint) 20%, var(--color-panel));
    border-color: color-mix(in srgb, var(--tint) 32%, var(--color-line));
  }
</style>
