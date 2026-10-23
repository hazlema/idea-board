<script lang="ts" module>
  /** Where a dragged entry would land: before or after `entryId`, or at the end of `groupId`. */
  export interface EntryDrop {
    dragging: string | null;
    groupId: string | null;
    entryId: string | null;
    after: boolean;
  }

  /** Shared by every row and group, so the one under the pointer can show the drop line. */
  export const entryDrop: EntryDrop = $state({ dragging: null, groupId: null, entryId: null, after: false });
</script>

<script lang="ts">
  import ClaudeMark from './ClaudeMark.svelte';
  import { autogrow, outside } from '$lib/actions';
  import { Draft } from '$lib/draft.svelte';
  import { firstLine } from '$lib/format';
  import { live } from '$lib/live.svelte';
  import type { Check, Entry, Group } from '$lib/types';

  interface Props {
    group: Group;
    entry: Entry;
  }

  let { group, entry }: Props = $props();

  let menuOpen = $state(false);
  let labelWidth = $state(0);
  let textField: HTMLTextAreaElement | undefined = $state();

  /** The group that holds this entry now (it may have moved), or undefined once it is gone. */
  function holder(): Group | undefined {
    for (const o of live.board?.brainstorm.pages.flatMap((p) => p.objects) ?? []) {
      if (o.kind === 'group' && o.entries.some((e) => e.id === entry.id)) return o;
    }
    return undefined;
  }

  async function update(fields: { label?: string; text?: string; check?: Check }): Promise<unknown> {
    const at = holder();
    if (!at) return {};
    return live.send({ type: 'updateEntry', groupId: at.id, entryId: entry.id, ...fields });
  }

  const label = new Draft({ server: () => entry.label, save: (v) => update({ label: v }), delay: 400, valid: (v) => v.trim() !== '' });
  const text = new Draft({ server: () => entry.text, save: (v) => update({ text: v }), delay: 500 });

  const dropHere = $derived(entryDrop.entryId === entry.id && entryDrop.dragging !== entry.id);

  function point(): void {
    live.pointing = { kind: 'entry', id: entry.id, groupId: group.id, label: firstLine(label.shown) || 'Untitled item' };
  }

  function unpoint(): void {
    if (live.pointing?.id === entry.id) live.pointing = null;
  }

  function toggle(event: MouseEvent): void {
    // The board, not the click, decides what the box shows.
    event.preventDefault();
    void update({ check: entry.check === 'done' ? 'open' : 'done' });
  }

  function setCheck(check: Check): void {
    menuOpen = false;
    void update({ check });
  }

  function ruleOut(): void {
    menuOpen = false;
    const reason = window.prompt('Why not?');
    if (reason === null) return;
    sendRuleOut(reason.trim());
  }

  function sendRuleOut(reason: string): void {
    unpoint();
    void live.send({ type: 'ruleOut', target: { kind: 'entry', groupId: group.id, entryId: entry.id }, reason });
  }

  function remove(): void {
    menuOpen = false;
    label.cancel();
    text.cancel();
    unpoint();
    void live.send({ type: 'deleteEntry', groupId: group.id, entryId: entry.id });
  }

  function labelKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    textField?.focus();
  }

  // ---- reordering: drag the handle onto another row or group ----

  function dropAt(clientX: number, clientY: number): void {
    const under = document.elementFromPoint(clientX, clientY);
    const row = under?.closest<HTMLElement>('[data-entry-id]');
    const box = under?.closest<HTMLElement>('[data-group-id]');
    entryDrop.groupId = box?.dataset.groupId ?? null;
    entryDrop.entryId = row && row.dataset.entryId !== entry.id ? (row.dataset.entryId ?? null) : null;
    entryDrop.after = row ? clientY > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2 : false;
  }

  /** The moveEntry for where the entry was dropped, or null when it would stay put. */
  function moveFor(drop: EntryDrop): { toGroupId: string; index?: number } | null {
    const target = live.board?.brainstorm.pages.flatMap((p) => p.objects).find((o) => o.id === drop.groupId);
    if (!target || target.kind !== 'group') return null;
    const from = target.entries.findIndex((e) => e.id === entry.id);
    if (!drop.entryId) return from === -1 || from !== target.entries.length - 1 ? { toGroupId: target.id } : null;
    let index = target.entries.findIndex((e) => e.id === drop.entryId);
    if (index === -1) return null;
    if (drop.after) index += 1;
    // The server takes the entry out before putting it back.
    if (from !== -1 && from < index) index -= 1;
    return index === from ? null : { toGroupId: target.id, index };
  }

  function startReorder(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture?.(event.pointerId);
    entryDrop.dragging = entry.id;
    const move = (e: PointerEvent) => dropAt(e.clientX, e.clientY);
    const end = (e: PointerEvent) => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      const drop = e.type === 'pointerup' ? moveFor($state.snapshot(entryDrop)) : null;
      Object.assign(entryDrop, { dragging: null, groupId: null, entryId: null, after: false });
      if (drop) void live.send({ type: 'moveEntry', entryId: entry.id, ...drop });
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  const item = 'block w-full px-3 py-1 text-left hover:bg-raised';
</script>

<!-- Pressing anywhere on the row points chat at it; the fields do the same on focus. -->
<li
  data-entry-id={entry.id}
  data-testid="entry-{entry.id}"
  class="group/row relative flex items-start gap-2 {entry.claudeAdded ? 'rounded-lg bg-orange-400/10 px-2 py-1.5' : ''} {entryDrop.dragging === entry.id ? 'opacity-40' : ''} {live.flash.has(entry.id) ? 'flash-claude' : ''}"
  onpointerdown={point}
>
  {#if dropHere}
    <div class="pointer-events-none absolute right-0 left-0 h-0.5 rounded bg-accent {entryDrop.after ? '-bottom-1' : '-top-1'}"></div>
  {/if}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <span
    class="absolute top-0.5 -left-3.5 cursor-grab text-xs text-muted opacity-0 select-none group-hover/row:opacity-100 hover:text-text"
    title="Drag to reorder or move to another group"
    onpointerdown={startReorder}>⠿</span
  >
  {#if entry.check === 'none'}
    <span class="w-[13px] shrink-0 text-center text-muted" aria-hidden="true">•</span>
  {:else}
    <input type="checkbox" class="mt-[3px] shrink-0 cursor-pointer accent-green-500" aria-label="Agreed" checked={entry.check === 'done'} onclick={toggle} />
  {/if}

  <div class="min-w-0 flex-1">
    <!-- The label sits on the first line of the text, which is indented past it. -->
    <div class="relative">
      <div class="absolute top-0 left-0 z-10 flex max-w-full font-semibold" bind:offsetWidth={labelWidth}>
        <input
          type="text"
          maxlength="200"
          placeholder="Label"
          aria-label="Label"
          size={Math.max(1, label.shown.length)}
          class="field-sizing-content max-w-full min-w-[2ch] rounded-sm bg-transparent p-0 leading-[1.45] font-semibold outline-none focus:bg-ink/60"
          {...label.attrs}
          onfocus={() => {
            label.focus();
            point();
          }}
          onkeydown={labelKeydown}
        /><span aria-hidden="true">:</span>
      </div>
      <textarea
        bind:this={textField}
        rows="1"
        aria-label="Text"
        class="block w-full resize-none overflow-hidden rounded-sm bg-transparent p-0 leading-[1.45] outline-none focus:bg-ink/60 {entry.check === 'done' ? 'text-green-300' : ''}"
        style:text-indent="{labelWidth + 4}px"
        use:autogrow={text.shown}
        {...text.attrs}
        onfocus={() => {
          text.focus();
          point();
        }}
      ></textarea>
    </div>
    {#if entry.claudeAdded}
      <ClaudeMark variant="entry" onkeep={() => void live.send({ type: 'keep', id: group.id, entryId: entry.id })} ondismiss={sendRuleOut} />
    {/if}
  </div>

  <div class="relative shrink-0" use:outside={() => (menuOpen = false)}>
    <button
      type="button"
      class="px-1 leading-none text-muted opacity-0 group-hover/row:opacity-100 hover:text-text focus:opacity-100 {menuOpen ? 'opacity-100' : ''}"
      aria-label="Item menu"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      onclick={() => (menuOpen = !menuOpen)}>⋯</button
    >
    {#if menuOpen}
      <div role="menu" class="absolute top-full right-0 z-30 mt-1 w-40 rounded-md border border-line bg-panel py-1 text-sm shadow-lg">
        {#if entry.check === 'none'}
          <button type="button" role="menuitem" class={item} onclick={() => setCheck('open')}>Add checkbox</button>
        {:else}
          <button type="button" role="menuitem" class={item} onclick={() => setCheck('none')}>Remove checkbox</button>
        {/if}
        <button type="button" role="menuitem" class={item} onclick={ruleOut}>Rule out…</button>
        <button type="button" role="menuitem" class="{item} text-rose-400" onclick={remove}>Delete</button>
      </div>
    {/if}
  </div>
</li>
