<script lang="ts" module>
  export type NewKind = 'group' | 'note' | 'topic';
</script>

<script lang="ts">
  interface Props {
    /** Linking two objects: which click comes next, or null when not linking. */
    linking: 'from' | 'to' | null;
    onadd: (kind: NewKind) => void;
    onpicture: () => void;
    onlink: () => void;
  }

  let { linking, onadd, onpicture, onlink }: Props = $props();

  const button = 'rounded-md px-2.5 py-1 text-left hover:bg-raised';
</script>

<div data-nopan class="absolute top-3.5 left-3.5 z-20 flex flex-col gap-1 rounded-[10px] border border-line bg-panel/95 p-1.5 shadow-lg backdrop-blur" role="toolbar" aria-label="Add to the canvas" aria-orientation="vertical">
  <button type="button" class={button} title="Add a group of items" onclick={() => onadd('group')}>▤ Group</button>
  <button type="button" class={button} title="Add a sticky note" onclick={() => onadd('note')}>✎ Note</button>
  <button type="button" class={button} title="Add a topic bubble" onclick={() => onadd('topic')}>● Topic</button>
  <button type="button" class={button} title="Add a picture (or paste or drop one on the canvas)" onclick={onpicture}>▣ Picture</button>
  <button type="button" class="{button} {linking ? 'bg-accent/25 text-text' : ''}" aria-pressed={linking !== null} title="Link two objects" onclick={onlink}>↗ Link</button>
  {#if linking}
    <p class="m-0 max-w-32 px-1 text-xs text-muted" role="status">{linking === 'from' ? 'Click the first object' : 'Now click the object to link to'} · Esc to stop</p>
  {/if}
</div>
