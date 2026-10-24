<script lang="ts">
  import { untrack } from 'svelte';
  import * as api from '$lib/api';
  import { authorColor, cardIds } from '$lib/authors';
  import { live } from '$lib/live.svelte';
  import type { Author, LineupAgent } from '$lib/types';
  import { colabState } from './colab.svelte';
  import ClaudeModelPopup from './ClaudeModelPopup.svelte';
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
  let claudeRoleId = $state('foreman');
  let imageModel = $state('');
  let claudeModel = $state('sonnet');
  let claudePopup = $state(false);
  let claudeButton = $state<HTMLButtonElement>();
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
      claudeRoleId = lineup.claudeRoleId ?? 'foreman';
      imageModel = lineup.imageModel ?? '';
      claudeModel = lineup.claudeModel ?? 'sonnet';
    });
  });

  $effect(() => {
    untrack(() => void colabState.load());
  });

  const status = $derived(live.colab);
  const canEdit = $derived(status?.state === 'idle');
  const roles = $derived(colabState.library.roles);

  const ids = $derived(cardIds(agents));
  const isCurrent = (i: number): boolean => !!status?.current && status.current === ids[i];
  // The working connection's colour, as its name shows in chat.
  const colorOf = (i: number): string => authorColor(live.board, ids[i] as Author);

  const claudeVia = $derived(status?.claude === 'binary' ? '(via binary)' : status?.claude === 'mcp' ? '(via MCP)' : status?.claude === 'none' ? '(not connected)' : '');
  const claudeThinking = $derived(live.agent === 'working' || status?.current === 'claude');
  const spent = $derived(status?.spent ?? live.board?.colab?.spent ?? 0);
  const mcpCommand = $derived(`claude mcp add --transport http idea-board ${location.origin}/mcp`);

  const MODEL_LABELS: Record<string, string> = { sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku', fable: 'Fable' };
  const claudeLabel = $derived(MODEL_LABELS[claudeModel] ?? claudeModel);

  // A run starting closes the popup; it stays closed when the run ends.
  $effect(() => {
    if (!canEdit) claudePopup = false;
  });

  function closeClaudePopup(): void {
    claudePopup = false;
    claudeButton?.focus();
  }

  function saveClaudeModel(model: string): void {
    claudeModel = model;
    send();
    closeClaudePopup();
  }

  function activityOf(i: number): { text: string; thinking: boolean; over: boolean } {
    const c = status?.connections?.[ids[i]];
    if (c?.state === 'over-budget') return { text: 'Over budget', thinking: false, over: true };
    if (c?.state === 'thinking') return { text: `${c.activity ?? 'taking its turn'}…`, thinking: true, over: false };
    return { text: 'Waiting', thinking: false, over: false };
  }

  // "$0.42 of $5"; small spends keep a third decimal, so money spent never reads $0.00.
  const money = (n: number): string => (Number.isInteger(n) ? String(n) : n > 0 && n < 0.1 ? n.toFixed(3) : n.toFixed(2));

  function send(): void {
    void live.send({ type: 'setColabLineup', agents, rounds, budget, turnLimit, claudeRoleId, imageModel, claudeModel });
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

  async function resetSpent(): Promise<void> {
    if (!confirm('Reset spent to $0.00?')) return;
    try {
      live.colab = await api.resetSpent();
    } catch (error) {
      live.toast(error instanceof Error ? error.message : 'Could not reset');
    }
  }
</script>

<aside class="flex w-65 shrink-0 flex-col gap-3 overflow-y-auto border-l border-line bg-panel p-3 text-sm" aria-label="Connections">
  <h2 class="text-xs font-semibold tracking-wide text-muted uppercase">Direct connection</h2>
  <div class="relative rounded-md border border-line bg-raised p-2">
    <p class="font-semibold text-text">
      <button
        type="button"
        class="text-left font-semibold hover:underline disabled:no-underline disabled:opacity-60"
        aria-haspopup="true"
        aria-expanded={claudePopup}
        disabled={!canEdit}
        bind:this={claudeButton}
        onclick={() => (claudePopup = !claudePopup)}>1. <span style:color="var(--color-claude)">Claude · {claudeLabel}</span></button
      >
      <span class="font-normal text-muted">{claudeVia}</span>
    </p>
    {#if claudePopup && canEdit}
      <ClaudeModelPopup value={claudeModel} mcp={status?.claude === 'mcp'} onsave={saveClaudeModel} onclose={closeClaudePopup} />
    {/if}
    <label class="mt-1 flex items-center gap-2 text-muted"
      >Role:
      <select
        class="min-w-0 flex-1 rounded-md border border-line bg-ink px-1 py-0.5 text-text disabled:opacity-60"
        aria-label="Claude role"
        disabled={!canEdit}
        value={claudeRoleId}
        onchange={(e) => {
          claudeRoleId = e.currentTarget.value;
          send();
        }}
      >
        {#if !roles.some((r) => r.id === claudeRoleId)}
          <option value={claudeRoleId}>{claudeRoleId} (missing)</option>
        {/if}
        {#each roles as role (role.id)}
          <option value={role.id}>{role.name}</option>
        {/each}
      </select>
    </label>
    <p class="mt-1 text-muted">
      Activity: {#if claudeThinking}<span class="font-medium" style:color="var(--color-claude)"><span class="animate-pulse">●</span> Thinking…</span>{:else}<span>Waiting</span>{/if}
    </p>
  </div>
  {#if status?.claude === 'none'}
    <div class="rounded-md border border-line bg-raised p-2 text-muted">
      <p>
        The claude command wasn't found. To connect Claude from your own session, run this in your project, then ask Claude to "listen to the board chat":
      </p>
      <pre class="mt-1 overflow-x-auto rounded bg-ink p-1.5 text-[11px] whitespace-pre-wrap text-text select-all">{mcpCommand}</pre>
    </div>
  {/if}

  <h2 class="text-xs font-semibold tracking-wide text-muted uppercase">OpenRouter connections</h2>

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

  {#if !agents.length}<p class="text-muted">None yet.</p>{/if}
  <ol class="flex flex-col gap-2">
    {#each agents as agent, i (i)}
      {@const activity = activityOf(i)}
      <li
        class="rounded-md border p-2 {isCurrent(i) ? '' : 'border-line bg-raised'}"
        style:border-color={isCurrent(i) ? colorOf(i) : undefined}
        style:background={isCurrent(i) ? `color-mix(in srgb, ${colorOf(i)} 12%, var(--color-raised))` : undefined}
        aria-current={isCurrent(i) ? 'true' : undefined}
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
          <span class="mt-1 font-semibold text-text">{i + 2} ·</span>
          <div class="min-w-0 flex-1">
            <ModelPicker value={agent.model} models={colabState.models} disabled={!canEdit} onchange={(id) => edit(i, { model: id })} />
          </div>
          <button type="button" class="mt-0.5 px-1 text-muted hover:text-text disabled:opacity-40" aria-label="Remove connection {i + 2}" disabled={!canEdit} onclick={() => remove(i)}>✕</button>
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
        <p class="mt-1 pl-[1.6rem] text-xs {activity.thinking ? 'font-medium' : 'text-muted'} {activity.over ? 'text-accent' : ''}" style:color={activity.thinking ? colorOf(i) : undefined}>
          Activity: {#if activity.thinking}<span class="animate-pulse">●</span>{/if}
          {activity.text}
        </p>
      </li>
    {/each}
  </ol>

  <button type="button" class="rounded-md border border-line px-2 py-1 text-text hover:border-muted disabled:opacity-40" disabled={!canEdit} onclick={() => (adding = true)}>+ Add connection</button>

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
    >Turn timeout (min)
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

  <div class="flex flex-col gap-0.5 text-muted">
    <span>Image model</span>
    <ModelPicker
      value={imageModel}
      models={colabState.imageModels}
      disabled={!canEdit}
      ariaLabel="Image model"
      onchange={(id) => {
        imageModel = id;
        send();
      }}
    />
    <span class="text-xs">Used by roles that can make pictures.</span>
  </div>

  <p class="flex items-baseline justify-between gap-2 text-muted" aria-live="polite">
    <span>Spent ${money(spent)} of ${money(status?.budget ?? budget)}</span>
    <button type="button" class="text-muted underline hover:text-text" onclick={resetSpent}>Reset</button>
  </p>

  <button type="button" class="self-start text-muted underline hover:text-text" onclick={() => (editingRoles = true)}>Edit roles…</button>
</aside>

{#if adding}
  <AddAgentDialog models={colabState.models} modelsError={colabState.modelsError} {roles} onadd={add} onclose={() => (adding = false)} />
{/if}

{#if editingRoles}
  <RoleEditor onclose={() => (editingRoles = false)} />
{/if}
