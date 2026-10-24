<script lang="ts">
  import { untrack } from 'svelte';
  import * as api from '$lib/api';
  import { authorColor } from '$lib/authors';
  import { live } from '$lib/live.svelte';
  import type { LineupAgent } from '$lib/types';
  import { colabState } from './colab.svelte';
  import AddAgentDialog from './AddAgentDialog.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import RoleEditor from './RoleEditor.svelte';

  const KEY_COMMAND =
    'mkdir -p ~/.config/openrouter && read -rs -p "OpenRouter key: " k && printf \'%s\' "$k" > ~/.config/openrouter/key && chmod 600 ~/.config/openrouter/key; unset k; echo';

  // The line-up as edited here; it follows the board whenever the board's line-up changes.
  let agents = $state<LineupAgent[]>([]);
  let rounds = $state(5);
  let budget = $state(5);
  let turnLimit = $state(30);
  let editingRoles = $state(false);
  let adding = $state(false);
  let dragFrom = $state<number | null>(null);

  $effect(() => {
    const lineup = live.board?.colab?.lineup;
    if (!lineup) return;
    untrack(() => {
      agents = lineup.agents.map((a) => ({ ...a }));
      rounds = lineup.rounds;
      budget = lineup.budget;
      turnLimit = lineup.turnLimit ?? 30;
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
  // The working agent's colour, as its name shows in chat.
  const colorOf = (a: LineupAgent): string => authorColor(live.board, `agent:${a.model}=${a.roleId}`);

  // "$0.42 of $5"; small spends keep a third decimal, so money spent never reads $0.00.
  const money = (n: number): string => (Number.isInteger(n) ? String(n) : n > 0 && n < 0.1 ? n.toFixed(3) : n.toFixed(2));

  function send(): void {
    void live.send({ type: 'setColabLineup', agents, rounds, budget, turnLimit });
  }

  function edit(index: number, patch: Partial<LineupAgent>): void {
    agents = agents.map((a, i) => (i === index ? { ...a, ...patch } : a));
    send();
  }

  function add(agent: LineupAgent): void {
    adding = false;
    agents = [...agents, agent];
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
  <div class="flex items-baseline justify-between">
    <h2 class="text-xs font-semibold tracking-wide text-muted uppercase">Agents</h2>
    {#if status && busy}<span class="text-muted" aria-live="polite">${money(status.spent)} of ${money(status.budget)}</span>{/if}
  </div>

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
        class="rounded-md border p-2 {isCurrent(agent) ? '' : 'border-line bg-raised'}"
        style:border-color={isCurrent(agent) ? colorOf(agent) : undefined}
        style:background={isCurrent(agent) ? `color-mix(in srgb, ${colorOf(agent)} 12%, var(--color-raised))` : undefined}
        aria-current={isCurrent(agent) ? 'true' : undefined}
        ondragover={(e) => e.preventDefault()}
        ondrop={(e) => {
          e.preventDefault();
          drop(i);
        }}
      >
        <!-- As in the design: the model first ("1 · Claude Sonnet 5.5"), then its role. -->
        <div class="flex items-start gap-1.5">
          <!-- Only the grip drags, so text in the model box can still be selected (Firefox). -->
          <span
            class="mt-1 w-3 cursor-grab text-muted select-none"
            role="presentation"
            title={canEdit ? 'Drag to reorder' : undefined}
            draggable={canEdit}
            ondragstart={(e) => {
              e.dataTransfer?.setData('text/plain', String(i));
              dragFrom = i;
            }}
            ondragend={() => (dragFrom = null)}>{canEdit ? '⠿' : ''}</span
          >
          <span class="mt-1 font-semibold text-text">{i + 1} ·</span>
          <div class="min-w-0 flex-1">
            <ModelPicker value={agent.model} models={colabState.models} disabled={!canEdit} onchange={(id) => edit(i, { model: id })} />
          </div>
          <button type="button" class="mt-0.5 px-1 text-muted hover:text-text disabled:opacity-40" aria-label="Remove agent {i + 1}" disabled={!canEdit} onclick={() => remove(i)}>✕</button>
        </div>
        <label class="mt-1 flex items-center gap-2 pl-[1.6rem] text-muted"
          >Role:
          <select
            class="min-w-0 flex-1 rounded-md border border-line bg-ink px-1 py-0.5 text-text disabled:opacity-60"
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
        </label>
        {#if colabState.loaded && !roles.some((r) => r.id === agent.roleId)}<p class="mt-1 pl-[1.6rem] text-xs text-accent">Role missing</p>{/if}
        {#if isCurrent(agent)}
          <p class="mt-1 pl-[1.6rem] text-xs font-medium" style:color={colorOf(agent)}><span class="animate-pulse">●</span> {status?.activity ?? 'taking its turn'}…</p>
        {/if}
      </li>
    {/each}
  </ol>

  <button type="button" class="rounded-md border border-line px-2 py-1 text-text hover:border-muted disabled:opacity-40" disabled={!canEdit} onclick={() => (adding = true)}>+ Add agent</button>

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
          e.currentTarget.value = String(rounds);
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
          e.currentTarget.value = String(budget);
          send();
        }}
      />
    </label>
  </div>
  <label class="flex items-center gap-2 text-muted" title="How long one agent's turn may take; then it is asked to wrap up. Slow models can need 20 minutes."
    >Turn limit (min)
    <input
      type="number"
      min="1"
      max="120"
      class="w-20 rounded-md border border-line bg-ink px-2 py-1 text-text disabled:opacity-60"
      disabled={!canEdit}
      value={turnLimit}
      onchange={(e) => {
        turnLimit = Math.round(number(e.currentTarget.value, 1, 120, turnLimit));
        e.currentTarget.value = String(turnLimit);
        send();
      }}
    />
  </label>

  {#if status?.state === 'running' || status?.state === 'waiting' || status?.state === 'stopping'}
    <button type="button" class="rounded-md border border-rose-400 px-3 py-1.5 font-semibold text-rose-400 hover:bg-rose-400/10 disabled:opacity-60" disabled={status.state === 'stopping'} onclick={stop}
      >{status.state === 'stopping' ? 'Stopping…' : 'Stop'}</button
    >
  {:else}
    <button type="button" class="rounded-md bg-accent px-3 py-1.5 font-semibold text-ink disabled:opacity-40" disabled={!!problem || !canEdit} onclick={start}>Start</button>
    <p class="text-muted">{problem ?? 'Start brings them in; they wait for your first message.'}</p>
  {/if}

  <button type="button" class="self-start text-muted underline hover:text-text" onclick={() => (editingRoles = true)}>Edit roles…</button>
</aside>

{#if adding}
  <AddAgentDialog models={colabState.models} modelsError={colabState.modelsError} {roles} onadd={add} onclose={() => (adding = false)} />
{/if}

{#if editingRoles}
  <RoleEditor onclose={() => (editingRoles = false)} />
{/if}
