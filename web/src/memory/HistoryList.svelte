<script lang="ts">
  import { untrack } from 'svelte';
  import * as api from '$lib/api';
  import { authorColor, authorName, isAi } from '$lib/authors';
  import { ago } from '$lib/format';
  import { live } from '$lib/live.svelte';
  import type { HistoryRow, VersionMeta } from '$lib/types';
  import { preview, restoreVersion } from './preview.svelte';

  const PAGE = 50;

  // One reply from Claude is a single group; everything else is a row of its own.
  type Item =
    | { kind: 'changes'; key: string; at: string; author: HistoryRow['author']; turn: string | null; rows: HistoryRow[] }
    | { kind: 'version'; key: string; at: string; meta: VersionMeta };

  let rows = $state<HistoryRow[]>([]);
  let versions = $state<VersionMeta[]>([]);
  let more = $state(false);
  let loaded = $state(false);

  const time = (iso: string): number => new Date(iso).getTime();

  function grouped(list: HistoryRow[]): Item[] {
    const items: Item[] = [];
    for (const row of list) {
      const last = items.at(-1);
      if (isAi(row.author) && row.turn && last?.kind === 'changes' && last.turn === row.turn) {
        last.rows.push(row);
      } else {
        items.push({ kind: 'changes', key: `h${row.seq}`, at: row.at, author: row.author, turn: isAi(row.author) && row.turn ? row.turn : null, rows: [row] });
      }
    }
    return items;
  }

  const items = $derived.by((): Item[] => {
    const changes = grouped(rows);
    const marks: Item[] = versions.map((meta) => ({ kind: 'version', key: `v${meta.id}`, at: meta.at, meta }));
    return [...changes, ...marks].sort((a, b) => time(b.at) - time(a.at));
  });

  async function loadHistory(limit: number): Promise<void> {
    try {
      const history = await api.history(limit);
      rows = history;
      more = history.length >= limit;
    } catch (error) {
      live.toast(error instanceof Error ? error.message : 'Could not load the history');
    } finally {
      loaded = true;
    }
  }

  async function loadVersions(): Promise<void> {
    try {
      versions = await api.versions();
    } catch (error) {
      live.toast(error instanceof Error ? error.message : 'Could not load the saved versions');
    }
  }

  // Loads first, and again whenever the server records a change.
  $effect(() => {
    void live.historyTick;
    // Reloads as many rows as are showing, without depending on them.
    const limit = untrack(() => Math.min(500, Math.max(PAGE, rows.length)));
    void loadHistory(limit);
  });

  // Every saved version is a file on the server: read the list only when it changes.
  $effect(() => {
    void live.versionsTick;
    void loadVersions();
  });

  async function loadMore(): Promise<void> {
    const oldest = rows.at(-1);
    if (!oldest) return;
    try {
      const older = await api.history(PAGE, oldest.seq);
      rows = [...rows, ...older];
      more = older.length >= PAGE;
    } catch (error) {
      live.toast(error instanceof Error ? error.message : 'Could not load more');
    }
  }

  async function undoReply(turn: string): Promise<void> {
    try {
      const { skipped } = await api.undoTurn(turn);
      live.toast(skipped.length ? `Kept ${skipped.length} item${skipped.length === 1 ? '' : 's'} you changed since.` : 'Undone. ↷ brings it back.');
    } catch (error) {
      live.toast(error instanceof Error ? error.message : 'Could not undo that reply');
    }
  }

  const stamp = (iso: string): string => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  const small = 'rounded-md border border-line bg-panel px-2 py-px text-xs hover:border-muted';
</script>

<div class="flex flex-col gap-2">
  {#each items as item (item.key)}
    {#if item.kind === 'version'}
      <article class="rounded-lg border border-accent/60 bg-accent/10 px-3 py-2" class:ring-1={preview.current?.meta.id === item.meta.id} class:ring-accent={preview.current?.meta.id === item.meta.id}>
        <div class="font-medium">★ Version: “{item.meta.name}”</div>
        <div class="mt-0.5 text-xs text-muted">
          {stamp(item.meta.at)} · {count(item.meta.stats.groups, 'group', 'groups')}, {count(item.meta.stats.entries, 'entry', 'entries')}, {count(item.meta.stats.pictures, 'picture', 'pictures')}
        </div>
        <div class="mt-1.5 flex gap-1.5">
          <button type="button" class={small} onclick={() => void preview.open(item.meta.id)}>Preview</button>
          <button type="button" class={small} onclick={() => void restoreVersion(item.meta)}>Restore</button>
        </div>
      </article>
    {:else}
      {@const turn = item.turn}
      {@const open = item.rows.filter((r) => !r.undone)}
      <article class="rounded-lg border bg-raised px-3 py-2 {isAi(item.author) ? 'border-claude/40' : 'border-line'}">
        <div class="flex items-center gap-2 text-xs text-muted">
          <span class="font-semibold" style:color={isAi(item.author) ? authorColor(live.board, item.author) : undefined}>{authorName(live.board, item.author)}</span>
          <span>{ago(item.at)}</span>
          {#if turn && open.length}
            <button type="button" class="{small} ml-auto" onclick={() => void undoReply(turn)}>Undo this reply</button>
          {/if}
        </div>
        <ul class="mt-1 flex flex-col gap-0.5">
          {#each item.rows as row (row.seq)}
            <li class={row.undone ? 'text-muted' : ''} title="{authorName(live.board, row.author)} · {stamp(row.at)}">
              <span class={row.undone ? 'line-through' : ''}>{row.summary}</span>
              {#if row.undone}<span class="text-xs"> (undone)</span>{/if}
            </li>
          {/each}
        </ul>
      </article>
    {/if}
  {:else}
    {#if loaded}<p class="py-6 text-center text-muted">Nothing has changed yet.</p>{/if}
  {/each}

  {#if more}
    <button type="button" class="self-center {small}" onclick={() => void loadMore()}>Load more</button>
  {/if}
</div>
