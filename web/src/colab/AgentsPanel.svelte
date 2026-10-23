<script lang="ts">
  import { untrack } from 'svelte';
  import * as api from '$lib/api';
  import { live } from '$lib/live.svelte';
  import type { LineupAgent } from '$lib/types';
  import { colabState } from './colab.svelte';
  import ModelPicker from './ModelPicker.svelte';

  const KEY_COMMAND =
    'mkdir -p ~/.config/openrouter && read -rs -p "OpenRouter key: " k && printf \'%s\' "$k" > ~/.config/openrouter/key && chmod 600 ~/.config/openrouter/key; unset k; echo';

  // The line-up as edited here; it follows the board whenever the board's line-up changes.
  let agents = $state<LineupAgent[]>([]);
  let rounds = $state(5);
  let budget = $state(5);
  let editingRoles = $state(false);
  let dragFrom = $state<number | null>(null);

  $effect(() => {
    const lineup = live.board?.colab?.lineup;
    if (!lineup) return;
    untrack(() => {
      agents = lineup.agents.map((a) => ({ ...a }));
      rounds = lineup.rounds;
      budget = lineup.budget;
    });
  });

  $effect(() => {
    untrack(() => void colabState.load());
  });

  const status = $derived(live.colab);
  const canEdit = $derived(status?.state === 'idle');
  const busy = $derived(!!status && status.state !== 'idle');
  const roles = $derived(colabState.library.roles);
  const roster = $derived(live.board?.colab?.roster ?? []);

  const problem = $derived.by(() => {
    if (!colabState.hasKey) return 'No OpenRouter key is set.';
    if (!agents.length) return 'Add at least one agent.';
    const noModel = agents.findIndex((a) => !a.model);
    if (noModel >= 0) return `Agent ${noModel + 1} has no model.`;
    if (colabState.loaded) {
      const noRole = agents.findIndex((a) => !roles.some((r) => r.id === a.roleId));
      if (noRole >= 0) return `Agent ${noRole + 1}'s role is not in the library.`;
    }
    return null;
  });

  const isCurrent = (a: LineupAgent): boolean => !!status?.current && status.current === roster.find((r) => r.id === `agent:${a.model}=${a.roleId}`)?.id;

  function send(): void {
    void live.send({ type: 'setColabLineup', agents, rounds, budget });
  }

  function edit(index: number, patch: Partial<LineupAgent>): void {
    agents = agents.map((a, i) => (i === index ? { ...a, ...patch } : a));
    send();
  }

  function add(): void {
    agents = [...agents, { model: '', roleId: roles.some((r) => r.id === 'creative') ? 'creative' : (roles[0]?.id ?? 'creative'), settings: {} }];
    send();
  }

  function remove(index: number): void {
    agents = agents.filter((_, i) => i !== index);
    send();
  }

  function drop(to: number): void {
    if (dragFrom === null || dragFrom === to) return;
    const next = [...agents];
    const [moved] = next.splice(dragFrom, 1);
    next.splice(to, 0, moved);
    agents = next;
    dragFrom = null;
    send();
  }

  function number(raw: string, min: number, max: number, fallback: number): number {
    const n = Number(raw);
    return Number.isFinite(n) && raw !== '' ? Math.min(max, Math.max(min, n)) : fallback;
  }

  async function start(): Promise<void> {
    try {
      live.colab = await api.startColab();
    } catch (error) {
      live.toast(error instanceof Error ? error.message : 'Could not start');
    }
  }

  async function stop(): Promise<void> {
    try {
      live.colab = await api.stopColab();
    } catch (error) {
      live.toast(error instanceof Error ? error.message : 'Could not stop');
    }
  }
</script>

<aside class="flex w-65 shrink-0 flex-col gap-3 overflow-y-auto border-l border-line bg-panel p-3 text-sm" aria-label="Agents">
  <h2 class="text-xs font-semibold tracking-wide text-muted uppercase">Agents</h2>

  {#if colabState.loaded && !colabState.hasKey}
    <div class="rounded-md border border-line bg-raised p-2 text-muted">
      <p>
        No OpenRouter key. Put it in <code class="text-text">~/.config/openrouter/key</code> (or set <code class="text-text">OPENROUTER_API_KEY</code>), then reload. To create the file:
      </p>
      <pre class="mt-1 overflow-x-auto rounded bg-ink p-1.5 text-[11px] whitespace-pre-wrap text-text select-all">{KEY_COMMAND}</pre>
    </div>
  {/if}

  {#if colabState.modelsError}
    <p class="text-muted" role="status">Couldn't load the model list ({colabState.modelsError}). Type a model id instead.</p>
  {/if}

  <ol class="flex flex-col gap-2">
    {#each agents as agent, i (i)}
      <li
        class="rounded-md border bg-raised p-2 {isCurrent(agent) ? 'border-accent' : 'border-line'}"
        aria-current={isCurrent(agent) ? 'true' : undefined}
        draggable={canEdit}
        ondragstart={() => (dragFrom = i)}
        ondragover={(e) => e.preventDefault()}
        ondrop={() => drop(i)}
        ondragend={() => (dragFrom = null)}
      >
        <div class="mb-1 flex items-center gap-2">
          <span class="text-muted" aria-hidden="true">{canEdit ? '⠿' : ''}</span>
          <span class="font-semibold text-text">{i + 1}</span>
          <select
            class="min-w-0 flex-1 rounded-md border border-line bg-ink px-1 py-1 text-text disabled:opacity-60"
            aria-label="Role"
            disabled={!canEdit}
            value={agent.roleId}
            onchange={(e) => edit(i, { roleId: e.currentTarget.value })}
          >
            {#if !roles.some((r) => r.id === agent.roleId)}
              <option value={agent.roleId}>{agent.roleId} (missing)</option>
            {/if}
            {#each roles as role (role.id)}
              <option value={role.id}>{role.name}</option>
            {/each}
          </select>
          <button type="button" class="px-1 text-muted hover:text-text disabled:opacity-40" aria-label="Remove agent {i + 1}" disabled={!canEdit} onclick={() => remove(i)}>✕</button>
        </div>
        <ModelPicker value={agent.model} models={colabState.models} disabled={!canEdit} onchange={(id) => edit(i, { model: id })} />
      </li>
    {/each}
  </ol>

  <button type="button" class="rounded-md border border-line px-2 py-1 text-text hover:border-muted disabled:opacity-40" disabled={!canEdit} onclick={add}>+ Add agent</button>

  <div class="flex gap-2">
    <label class="flex flex-1 flex-col gap-0.5 text-muted"
      >Rounds
      <input
        type="number"
        min="1"
        max="50"
        class="rounded-md border border-line bg-ink px-2 py-1 text-text disabled:opacity-60"
        disabled={!canEdit}
        value={rounds}
        onchange={(e) => {
          rounds = Math.round(number(e.currentTarget.value, 1, 50, rounds));
          send();
        }}
      />
    </label>
    <label class="flex flex-1 flex-col gap-0.5 text-muted"
      >Budget ($)
      <input
        type="number"
        min="0.1"
        max="100"
        step="0.1"
        class="rounded-md border border-line bg-ink px-2 py-1 text-text disabled:opacity-60"
        disabled={!canEdit}
        value={budget}
        onchange={(e) => {
          budget = number(e.currentTarget.value, 0.1, 100, budget);
          send();
        }}
      />
    </label>
  </div>

  {#if status && busy}
    <p class="text-muted" aria-live="polite">${status.spent.toFixed(2)} of ${status.budget}</p>
  {/if}

  {#if status?.state === 'running' || status?.state === 'waiting' || status?.state === 'stopping'}
    <button type="button" class="rounded-md border border-line bg-raised px-3 py-1.5 text-text hover:border-muted disabled:opacity-60" disabled={status.state === 'stopping'} onclick={stop}
      >{status.state === 'stopping' ? 'Stopping…' : 'Stop'}</button
    >
  {:else}
    <button type="button" class="rounded-md bg-accent px-3 py-1.5 font-semibold text-ink disabled:opacity-40" disabled={!!problem || !canEdit} onclick={start}>Start</button>
    {#if problem}<p class="text-muted">{problem}</p>{/if}
  {/if}

  <!-- Task 8 mounts the role editor when editingRoles is set. -->
  <button type="button" class="self-start text-muted underline hover:text-text" data-editing={editingRoles} onclick={() => (editingRoles = true)}>Edit roles…</button>
</aside>
