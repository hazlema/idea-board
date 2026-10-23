<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { ago } from '$lib/format';
  import { live } from '$lib/live.svelte';
  import type { Board, Section } from '$lib/types';

  type Field = 'title' | 'text';

  const DELAY: Record<Field, number> = { title: 400, text: 500 };
  const MAX_LABEL = 60;
  const keyOf = (id: string, field: Field) => `${id}:${field}`;

  interface Props {
    /** A board to show instead of the live one: the view is then read-only (a saved version's preview). */
    board?: Board;
  }

  let { board }: Props = $props();

  const readonly = $derived(board !== undefined);
  const sections = $derived((board ?? live.board)?.brief.sections ?? []);

  // What the user has typed and the server has not confirmed yet. A field with a
  // draft shows the draft, so an incoming board update never overwrites typing.
  let drafts = $state<Record<string, string>>({});
  let focused = $state<string | null>(null);
  let focusNew = $state<string | null>(null);
  let now = $state(Date.now());
  let column: HTMLDivElement | undefined = $state();

  const timers: Record<string, ReturnType<typeof setTimeout>> = {};

  onMount(() => {
    const tickTimer = setInterval(() => (now = Date.now()), 30_000);
    return () => {
      clearInterval(tickTimer);
      // Leaving the tab must not lose a half-debounced edit.
      for (const key of Object.keys(timers)) void flush(key);
    };
  });

  const shown = (section: Section, field: Field): string => drafts[keyOf(section.id, field)] ?? section[field];

  function dropDraft(key: string, sent: string): void {
    // Keep the draft while the field is still being edited or has moved on.
    if (focused !== key && drafts[key] === sent) delete drafts[key];
  }

  async function save(key: string): Promise<void> {
    const sent = drafts[key];
    if (sent === undefined) return;
    const [id, field] = key.split(':') as [string, Field];
    await live.send(field === 'title' ? { type: 'updateSection', id, title: sent } : { type: 'updateSection', id, text: sent });
    dropDraft(key, sent);
  }

  async function flush(key: string): Promise<void> {
    if (!(key in timers)) return;
    clearTimeout(timers[key]);
    delete timers[key];
    await save(key);
  }

  function type(section: Section, field: Field, value: string): void {
    const key = keyOf(section.id, field);
    drafts[key] = value;
    clearTimeout(timers[key]);
    timers[key] = setTimeout(() => {
      delete timers[key];
      void save(key);
    }, DELAY[field]);
  }

  function onFocus(section: Section, field: Field): void {
    focused = keyOf(section.id, field);
    point(section);
  }

  async function onBlur(section: Section, field: Field): Promise<void> {
    const key = keyOf(section.id, field);
    if (focused === key) focused = null;
    await flush(key);
    // Nothing was waiting to be saved: show the server's value again.
    if (!(key in timers) && drafts[key] !== undefined && focused !== key) delete drafts[key];
  }

  function point(section: Section): void {
    const title = shown(section, 'title').trim();
    live.pointing = { kind: 'section', id: section.id, label: (title || 'Untitled section').slice(0, MAX_LABEL) };
  }

  function titleKeydown(event: KeyboardEvent, section: Section): void {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    column?.querySelector<HTMLTextAreaElement>(`[data-id="${section.id}"] textarea`)?.focus();
  }

  async function add(): Promise<void> {
    const result = (await live.send({ type: 'addSection', title: '', text: '' })) as { section?: Section } | null;
    if (result?.section) focusNew = result.section.id;
  }

  // The new box arrives with the board update; focus its heading once it is there.
  $effect(() => {
    const id = focusNew;
    if (!id || !sections.some((s) => s.id === id)) return;
    focusNew = null;
    void tick().then(() => column?.querySelector<HTMLInputElement>(`[data-id="${id}"] input`)?.focus());
  });

  function remove(section: Section): void {
    const name = shown(section, 'title').trim();
    if ((name || shown(section, 'text').trim()) && !confirm(`Remove "${name || 'this box'}"?`)) return;
    for (const field of ['title', 'text'] as const) {
      const key = keyOf(section.id, field);
      clearTimeout(timers[key]);
      delete timers[key];
      delete drafts[key];
    }
    if (live.pointing?.id === section.id) live.pointing = null;
    void live.send({ type: 'deleteSection', id: section.id });
  }

  function move(section: Section, by: -1 | 1): void {
    void live.send({ type: 'moveSection', id: section.id, by });
  }

  /** Grows the textarea to fit its text. */
  function grow(node: HTMLTextAreaElement, _value: string) {
    const fit = () => {
      node.style.height = 'auto';
      node.style.height = `${node.scrollHeight + 2}px`;
    };
    fit();
    return { update: fit };
  }
</script>

<section class="min-h-0 flex-1 overflow-y-auto" aria-label="Brief">
  <div bind:this={column} inert={readonly} class="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-4 py-6">
    <p class="text-muted">Free-form notes about the project. Claude reads this before every change and adds to it when you settle something.</p>

    {#each sections as section, i (section.id)}
      <!-- Clicking anywhere on the box points chat at it; the fields inside do the same on focus, so keyboard users are covered. -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -->
      <div
        role="group"
        aria-label={shown(section, 'title') || 'Untitled section'}
        data-id={section.id}
        onclick={() => point(section)}
        class="rounded-lg border bg-panel px-3 pt-2 pb-1.5 focus-within:border-accent {live.flash.has(section.id) ? 'border-claude' : 'border-line'}"
      >
        <div class="flex items-center gap-0.5">
          <input
            type="text"
            maxlength="200"
            placeholder="Heading"
            aria-label="Heading"
            class="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 py-1 font-semibold hover:border-line"
            value={shown(section, 'title')}
            oninput={(e) => type(section, 'title', e.currentTarget.value)}
            onkeydown={(e) => titleKeydown(e, section)}
            onfocus={() => onFocus(section, 'title')}
            onblur={() => onBlur(section, 'title')}
          />
          <button type="button" class="px-1.5 py-0.5 text-muted hover:text-text" title="Move up" aria-label="Move up" disabled={i === 0} onclick={(e) => { e.stopPropagation(); move(section, -1); }}>↑</button>
          <button type="button" class="px-1.5 py-0.5 text-muted hover:text-text" title="Move down" aria-label="Move down" disabled={i === sections.length - 1} onclick={(e) => { e.stopPropagation(); move(section, 1); }}>↓</button>
          <button type="button" class="px-1.5 py-0.5 text-muted hover:text-rose-400" title="Remove this box" aria-label="Remove this box" onclick={(e) => { e.stopPropagation(); remove(section); }}>×</button>
        </div>
        <textarea
          placeholder="Write anything…"
          aria-label="Text"
          rows="2"
          class="block min-h-16 w-full resize-none overflow-hidden rounded border border-transparent bg-transparent px-1.5 py-1 hover:border-line"
          value={shown(section, 'text')}
          use:grow={shown(section, 'text')}
          oninput={(e) => type(section, 'text', e.currentTarget.value)}
          onfocus={() => onFocus(section, 'text')}
          onblur={() => onBlur(section, 'text')}
        ></textarea>
        <div class="px-1.5 text-xs text-muted">Last edit: {section.updatedBy === 'claude' ? 'Claude' : 'You'} · {ago(section.updatedAt, now)}</div>
      </div>
    {/each}

    {#if !readonly}
      <button type="button" class="self-start rounded-md border border-dashed border-line px-3 py-1.5 text-muted hover:border-accent hover:text-text" onclick={add}>+ Add text box</button>
    {/if}
  </div>
</section>
