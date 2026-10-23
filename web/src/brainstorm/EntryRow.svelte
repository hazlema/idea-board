<script lang="ts" module>
  import type { Group } from '$lib/types';

  /** Where a dragged entry would land: before or after `entryId`, or at the end of `groupId`. */
  export interface EntryDrop {
    dragging: string | null;
    groupId: string | null;
    entryId: string | null;
    after: boolean;
  }

  /** Shared by every row and group, so the one under the pointer can show the drop line. */
  export const entryDrop: EntryDrop = $state({ dragging: null, groupId: null, entryId: null, after: false });

  export const LABEL_GAP = 4;
  // Room the text needs beside the label before the label moves to its own line.
  const MIN_TEXT_ROOM = 48;

  /**
   * Whether the label goes on its own lines above the text. `labelWidth` is the
   * label's own (fit-content) width, `columnWidth` the row's text column.
   */
  export function labelStacks(labelWidth: number, columnWidth: number): boolean {
    return columnWidth > 0 && labelWidth + LABEL_GAP + MIN_TEXT_ROOM > columnWidth;
  }

  /**
   * A colon ends a label, as Enter does: a label typed or pasted as "Skill: Throw Dart"
   * is the label "Skill" and the text "Throw Dart". Null when there is no colon.
   */
  export function splitLabel(value: string, colon = value.indexOf(':')): { label: string; text: string } | null {
    if (colon === -1) return null;
    return { label: value.slice(0, colon), text: value.slice(colon + 1).trim() };
  }

  /**
   * Where the colon just typed or pasted into a label is, or -1. Only a new colon
   * ends the label: one already in a label (Claude's, or from before) stays.
   * `caret` is the cursor after the edit, just past what was inserted.
   */
  export function addedColon(before: string, after: string, caret: number): number {
    const start = Math.max(0, caret - (after.length - before.length));
    const colon = after.indexOf(':', start);
    return colon !== -1 && colon < caret ? colon : -1;
  }

  /**
   * The moveEntry that puts `entryId` where it was dropped, or null when it would stay put
   * (dropped on its own row, next to where it is, or on nothing).
   */
  export function entryMove(groups: Group[], entryId: string, drop: Omit<EntryDrop, 'dragging'>): { toGroupId: string; index?: number } | null {
    if (drop.entryId === entryId) return null;
    const target = groups.find((g) => g.id === drop.groupId);
    if (!target) return null;
    const from = target.entries.findIndex((e) => e.id === entryId);
    if (!drop.entryId) return from === -1 || from !== target.entries.length - 1 ? { toGroupId: target.id } : null;
    let index = target.entries.findIndex((e) => e.id === drop.entryId);
    if (index === -1) return null;
    if (drop.after) index += 1;
    // The server takes the entry out before putting it back.
    if (from !== -1 && from < index) index -= 1;
    return index === from ? null : { toGroupId: target.id, index };
  }
</script>

<script lang="ts">
  import ClaudeMark from './ClaudeMark.svelte';
  import { autogrow, outside } from '$lib/actions';
  import { Draft } from '$lib/draft.svelte';
  import { firstLine } from '$lib/format';
  import { live } from '$lib/live.svelte';
  import type { Check, Entry } from '$lib/types';

  interface Props {
    group: Group;
    entry: Entry;
  }

  let { group, entry }: Props = $props();

  let menuOpen = $state(false);
  let labelWidth = $state(0);
  let columnWidth = $state(0);

  const stacked = $derived(labelStacks(labelWidth, columnWidth));
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

  function labelInput(field: HTMLTextAreaElement): void {
    const value = field.value.replace(/\n/g, ' ');
    const split = splitLabel(value, addedColon(label.shown, value, field.selectionStart));
    if (!split) return label.input(value);
    // The draft may already hold this label (a colon typed at its end), so the field is set by hand.
    field.value = split.label;
    label.input(split.label);
    if (split.text) text.input(text.shown ? `${split.text} ${text.shown}` : split.text);
    textField?.focus();
  }

  function labelKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    textField?.focus();
  }

  // ---- reordering: drag the handle onto another row or group ----

  // Pointer travel before a drag counts, so a wiggle on the handle is not a move.
  const DRAG_THRESHOLD = 4;

  function dropAt(clientX: number, clientY: number): void {
    const under = document.elementFromPoint(clientX, clientY);
    const row = under?.closest<HTMLElement>('[data-entry-id]');
    const box = under?.closest<HTMLElement>('[data-group-id]');
    entryDrop.groupId = box?.dataset.groupId ?? null;
    // Over its own row, entryId is its own id: that means "stay put".
    entryDrop.entryId = row?.dataset.entryId ?? null;
    entryDrop.after = row ? clientY > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2 : false;
  }

  function startReorder(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    const start = { x: event.clientX, y: event.clientY };
    let dragging = false;
    handle.setPointerCapture?.(event.pointerId);
    const move = (e: PointerEvent) => {
      if (!dragging && Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) < DRAG_THRESHOLD) return;
      dragging = true;
      entryDrop.dragging = entry.id;
      dropAt(e.clientX, e.clientY);
    };
    const end = (e: PointerEvent) => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      const groups = (live.board?.brainstorm.pages ?? []).flatMap((p) => p.objects).filter((o): o is Group => o.kind === 'group');
      const drop = dragging && e.type === 'pointerup' ? entryMove(groups, entry.id, $state.snapshot(entryDrop)) : null;
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
  class="group/row relative flex items-start gap-2 {entry.claudeAdded ? 'rounded-lg bg-claude/10 px-2 py-1.5' : ''} {entryDrop.dragging === entry.id ? 'opacity-40' : ''} {live.flash.has(entry.id) ? 'flash-claude' : ''}"
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
    <!-- The label sits on the first line of the text, which is indented past it;
         a label too long for that goes on its own lines above the text. -->
    <div class="relative" bind:clientWidth={columnWidth}>
      <!-- w-fit: the wrapper is as wide as the label in both layouts, so a shortened label can go back inline. -->
      <div class="{stacked ? 'relative' : 'absolute top-0 left-0 z-10'} flex w-fit max-w-full items-end font-semibold" bind:offsetWidth={labelWidth}>
        <textarea
          rows="1"
          cols={Math.max(2, label.shown.length)}
          maxlength="200"
          placeholder="Label"
          aria-label="Label"
          class="field-sizing-content max-w-full min-w-[2ch] shrink resize-none overflow-hidden rounded-sm bg-transparent p-0 leading-[1.45] font-semibold [overflow-wrap:anywhere] outline-none focus:bg-ink/60"
          use:autogrow={label.shown}
          {...label.attrs}
          oninput={(e) => labelInput(e.currentTarget)}
          onfocus={() => {
            label.focus();
            point();
          }}
          onkeydown={labelKeydown}
        ></textarea><span class="shrink-0 {stacked ? 'invisible' : ''}" aria-hidden="true">:</span>
      </div>
      <textarea
        bind:this={textField}
        rows="1"
        aria-label="Text"
        class="block w-full resize-none overflow-hidden rounded-sm bg-transparent p-0 leading-[1.45] outline-none focus:bg-ink/60 {entry.check === 'done' ? 'text-green-300' : ''}"
        style:text-indent={stacked ? undefined : `${labelWidth + LABEL_GAP}px`}
        use:autogrow={text.shown}
        {...text.attrs}
        onfocus={() => {
          text.focus();
          point();
        }}
      ></textarea>
    </div>
    {#if entry.claudeAdded}
      <ClaudeMark variant="entry" by={entry.author} onkeep={() => void live.send({ type: 'keep', id: group.id, entryId: entry.id })} ondismiss={sendRuleOut} />
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
