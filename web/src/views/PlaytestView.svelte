<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import * as api from '$lib/api';
  import { authorColor, authorName } from '$lib/authors';
  import { ago } from '$lib/format';
  import { live } from '$lib/live.svelte';
  import type { Playtest, PlaytestSummary } from '$lib/types';

  // Paper playtests: games played against a referee who knows only the board. The list is on
  // the left, the chosen game's log on the right; the host plays their own game at the bottom.
  let games = $state<PlaytestSummary[]>([]);
  let shown = $state<Playtest | null>(null);
  /** The referee is ruling on the host's move. */
  let busy = $state(false);
  let action = $state('');
  let verdict = $state('');

  const summary = (game: Playtest): PlaytestSummary => ({
    id: game.id,
    player: game.player,
    startedAt: game.startedAt,
    endedAt: game.endedAt,
    over: game.over,
    actions: game.turns.filter((t) => t.action !== null).length,
    gaps: game.turns.reduce((n, t) => n + t.gaps.length, 0),
  });

  const mine = $derived(games.find((g) => g.player === 'user' && !g.endedAt));
  const playing = $derived(Boolean(shown && shown.player === 'user' && !shown.endedAt));
  const name = (game: { player: Playtest['player'] }): string => (game.player === 'user' ? 'You' : authorName(live.board, game.player));
  const status = (game: PlaytestSummary): string => (game.endedAt ? 'ended' : game.over ? 'over' : 'playing');

  function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : 'Something went wrong';
  }

  function upsert(game: Playtest): void {
    const row = summary(game);
    games = games.some((g) => g.id === game.id) ? games.map((g) => (g.id === game.id ? row : g)) : [row, ...games];
  }

  async function open(id: string): Promise<void> {
    try {
      shown = await api.playtest(id);
    } catch (error) {
      live.toast(messageOf(error));
    }
  }

  onMount(async () => {
    try {
      games = await api.playtests();
      if (!shown && games[0]) await open(games[0].id);
    } catch (error) {
      live.toast(messageOf(error));
    }
  });

  // A game changed on the server (an agent's turn, or the host's own): the list and the log follow.
  $effect(() => {
    const game = live.playtest;
    if (!game) return;
    // Only the event itself is tracked, so opening another game doesn't replay an old one.
    untrack(() => {
      upsert(game);
      if (!shown || shown.id === game.id) shown = game;
    });
  });

  // The host's turns go through the referee; while it rules, nothing else can be sent.
  async function play(send: () => Promise<Playtest>): Promise<boolean> {
    busy = true;
    try {
      const game = await send();
      upsert(game);
      shown = game;
      return true;
    } catch (error) {
      live.toast(messageOf(error));
      return false;
    } finally {
      busy = false;
    }
  }

  async function act(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const said = action.trim();
    if (!said || busy) return;
    if (await play(() => api.playtestAct(said))) action = '';
  }

  async function end(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const said = verdict.trim();
    if (!said || busy) return;
    if (await play(() => api.endPlaytest(said))) verdict = '';
  }

  const field = 'w-full resize-y rounded-md border border-line bg-ink px-2 py-1.5 text-text focus:border-accent disabled:opacity-60';
  const button = 'shrink-0 rounded-md border border-line bg-raised px-3 py-1 text-text hover:border-muted disabled:opacity-40';
</script>

<section class="flex min-w-0 flex-1 bg-panel" aria-label="Playtest">
  <aside class="flex w-72 shrink-0 flex-col border-r border-line">
    <div class="flex items-center justify-between gap-2 border-b border-line p-3">
      <h2 class="font-semibold">Playtests</h2>
      <button type="button" class={button} disabled={busy || Boolean(mine)} title={mine ? 'Your game is still open; end it first' : ''} onclick={() => play(api.startPlaytest)}
        >New playtest</button
      >
    </div>
    {#if games.length}
      <ul class="flex-1 overflow-y-auto" aria-label="Playtests">
        {#each games as game (game.id)}
          <li>
            <button
              type="button"
              class="flex w-full flex-col items-start gap-0.5 border-b border-line px-3 py-2 text-left hover:bg-raised {shown?.id === game.id ? 'bg-raised' : ''}"
              aria-current={shown?.id === game.id}
              onclick={() => open(game.id)}
            >
              <span class="font-medium" style:color={authorColor(live.board, game.player)}>{name(game)}</span>
              <span class="text-xs text-muted"
                >{ago(game.startedAt)} · {game.actions} action{game.actions === 1 ? '' : 's'} ·
                <span class={game.gaps ? 'text-amber-300' : ''}>{game.gaps} gap{game.gaps === 1 ? '' : 's'}</span> · {status(game)}</span
              >
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="p-3 text-sm text-muted">No playtests yet. Agents start them with playtest_start, or press New playtest to play one yourself.</p>
    {/if}
  </aside>

  <div class="flex min-w-0 flex-1 flex-col">
    {#if shown}
      <div class="flex-1 overflow-y-auto p-4">
        <div class="mx-auto flex max-w-3xl flex-col gap-4">
          <header class="flex items-baseline justify-between gap-2">
            <h2 class="text-lg font-semibold"><span style:color={authorColor(live.board, shown.player)}>{name(shown)}</span>'s playtest</h2>
            <span class="text-xs text-muted">started {ago(shown.startedAt)} · {status(summary(shown))}</span>
          </header>

          <section class="rounded-md border border-line bg-raised p-3" aria-label="State">
            <h3 class="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">State</h3>
            {#if shown.state.length}
              <ul class="list-disc pl-5">
                {#each shown.state as fact, i (i)}<li>{fact}</li>{/each}
              </ul>
            {:else}
              <p class="text-muted">Nothing yet.</p>
            {/if}
          </section>

          <ol class="flex flex-col gap-3" aria-label="Turns">
            {#each shown.turns as turn, i (i)}
              <li class="flex flex-col gap-1">
                {#if turn.action === null}
                  <p class="text-xs font-semibold tracking-wide text-muted uppercase">Opening</p>
                {:else}
                  <p><span class="text-muted">{i}.</span> <span class="font-medium" style:color={authorColor(live.board, shown.player)}>{turn.action}</span></p>
                {/if}
                <p class="whitespace-pre-wrap">{turn.happened}</p>
                {#each turn.gaps as gap, g (g)}
                  <p class="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-200">The rules don't say: {gap}</p>
                {/each}
                {#if turn.rollsUsed.length}<p class="text-xs text-muted">Dice: {turn.rollsUsed.join(', ')}</p>{/if}
              </li>
            {/each}
          </ol>

          {#if shown.assumed.length}
            <section class="rounded-md border border-line p-3" aria-label="Assumed">
              <h3 class="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Numbers the referee assumed</h3>
              <ul class="list-disc pl-5 text-muted">
                {#each shown.assumed as assumed, i (i)}<li>{assumed}</li>{/each}
              </ul>
            </section>
          {/if}

          {#if shown.verdict}
            <section class="rounded-md border border-line bg-raised p-3" aria-label="Verdict">
              <h3 class="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Verdict</h3>
              <p class="whitespace-pre-wrap">{shown.verdict}</p>
            </section>
          {/if}
        </div>
      </div>

      {#if playing}
        <div class="border-t border-line p-3">
          <div class="mx-auto flex max-w-3xl flex-col gap-2">
            {#if !shown.over}
              <form class="flex items-end gap-2" onsubmit={act}>
                <label class="flex flex-1 flex-col gap-1 text-xs text-muted"
                  >What do you do?
                  <input class={field} bind:value={action} disabled={busy} placeholder="Ring the bell in the market" />
                </label>
                <button type="submit" class={button} disabled={busy || !action.trim()}>{busy ? 'The referee is ruling…' : 'Do it'}</button>
              </form>
            {/if}
            <form class="flex items-end gap-2" onsubmit={end}>
              <label class="flex flex-1 flex-col gap-1 text-xs text-muted"
                >{shown.over ? 'The game is over. Your verdict' : 'Done? Your verdict'}
                <input class={field} bind:value={verdict} disabled={busy} placeholder="What worked, what broke, what was missing" />
              </label>
              <button type="submit" class={button} disabled={busy || !verdict.trim()}>End playtest</button>
            </form>
          </div>
        </div>
      {/if}
    {:else}
      <div class="flex flex-1 items-center justify-center p-4 text-muted">
        <p>Choose a playtest, or start one.</p>
      </div>
    {/if}
  </div>
</section>
