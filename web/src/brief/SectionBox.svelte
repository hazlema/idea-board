<script lang="ts">
  import { Draft } from '$lib/draft.svelte';
  import { ago } from '$lib/format';
  import { live } from '$lib/live.svelte';
  import type { Section } from '$lib/types';

  const MAX_LABEL = 60;

  interface Props {
    section: Section;
    first: boolean;
    last: boolean;
    /** The clock for "Last edit: … ago", ticked by the view. */
    now: number;
  }

  let { section, first, last, now }: Props = $props();

  let textField: HTMLTextAreaElement | undefined = $state();

  // Saving a section that is gone (deleted meanwhile) has nothing left to do.
  const exists = (): boolean => live.board?.brief.sections.some((s) => s.id === section.id) ?? false;
  const update = (fields: { title?: string; text?: string }): Promise<unknown> =>
    exists() ? live.send({ type: 'updateSection', id: section.id, ...fields }) : Promise.resolve({});

  const title = new Draft({ server: () => section.title, save: (v) => update({ title: v }), delay: 400 });
  const text = new Draft({ server: () => section.text, save: (v) => update({ text: v }), delay: 500 });

  function point(): void {
    const name = title.shown.trim();
    live.pointing = { kind: 'section', id: section.id, label: (name || 'Untitled section').slice(0, MAX_LABEL) };
  }

  function titleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    textField?.focus();
  }

  function remove(): void {
    const name = title.shown.trim();
    if ((name || text.shown.trim()) && !confirm(`Remove "${name || 'this box'}"?`)) return;
    title.cancel();
    text.cancel();
    if (live.pointing?.id === section.id) live.pointing = null;
    void live.send({ type: 'deleteSection', id: section.id });
  }

  function move(by: -1 | 1): void {
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

<!-- Clicking anywhere on the box points chat at it; the fields inside do the same on focus, so keyboard users are covered. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -->
<div
  role="group"
  aria-label={title.shown || 'Untitled section'}
  data-id={section.id}
  onclick={point}
  class="rounded-lg border bg-panel px-3 pt-2 pb-1.5 focus-within:border-accent {live.flash.has(section.id) ? 'border-claude' : 'border-line'}"
>
  <div class="flex items-center gap-0.5">
    <input
      type="text"
      maxlength="200"
      placeholder="Heading"
      aria-label="Heading"
      class="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 py-1 font-semibold hover:border-line"
      {...title.attrs}
      onfocus={() => {
        title.focus();
        point();
      }}
      onkeydown={titleKeydown}
    />
    <button type="button" class="px-1.5 py-0.5 text-muted hover:text-text" title="Move up" aria-label="Move up" disabled={first} onclick={(e) => { e.stopPropagation(); move(-1); }}>↑</button>
    <button type="button" class="px-1.5 py-0.5 text-muted hover:text-text" title="Move down" aria-label="Move down" disabled={last} onclick={(e) => { e.stopPropagation(); move(1); }}>↓</button>
    <button type="button" class="px-1.5 py-0.5 text-muted hover:text-rose-400" title="Remove this box" aria-label="Remove this box" onclick={(e) => { e.stopPropagation(); remove(); }}>×</button>
  </div>
  <textarea
    bind:this={textField}
    placeholder="Write anything…"
    aria-label="Text"
    rows="2"
    class="block min-h-16 w-full resize-none overflow-hidden rounded border border-transparent bg-transparent px-1.5 py-1 hover:border-line"
    use:grow={text.shown}
    {...text.attrs}
    onfocus={() => {
      text.focus();
      point();
    }}
  ></textarea>
  <div class="px-1.5 text-xs text-muted">Last edit: {section.updatedBy === 'claude' ? 'Claude' : 'You'} · {ago(section.updatedAt, now)}</div>
</div>
