<script lang="ts">
  import * as api from '$lib/api';
  import { live } from '$lib/live.svelte';
  import { colabState } from './colab.svelte';
  import RolePane from './RolePane.svelte';

  interface Props {
    onclose: () => void;
  }

  let { onclose }: Props = $props();

  /** A role id, or null for the shared rules. */
  let selected = $state<string | null>(null);
  const roles = $derived(colabState.library.roles);

  async function save(library: typeof colabState.library): Promise<boolean> {
    try {
      colabState.library = await api.saveLibrary(library);
      return true;
    } catch (error) {
      live.toast(error instanceof Error ? error.message : 'Could not save the roles');
      return false;
    }
  }

  async function addRole(): Promise<void> {
    const taken = new Set(roles.map((r) => r.id));
    let id = 'new-role';
    for (let n = 2; taken.has(id); n += 1) id = `new-role-${n}`;
    if (await save({ ...colabState.library, roles: [...roles, { id, name: 'New role', job: '' }] })) selected = id;
  }

  async function deleteRole(): Promise<void> {
    const role = roles.find((r) => r.id === selected);
    if (!role || roles.length <= 1 || !confirm(`Delete the role "${role.name}"?`)) return;
    if (await save({ ...colabState.library, roles: roles.filter((r) => r.id !== role.id) })) selected = null;
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') onclose();
  }

  const item = (active: boolean) => `rounded-md px-2 py-1.5 text-left ${active ? 'bg-raised text-text' : 'text-muted hover:text-text'}`;
</script>

<svelte:window onkeydown={keydown} />

<div class="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-6">
  <div class="flex h-full max-h-170 w-full max-w-4xl flex-col rounded-lg border border-line bg-panel shadow-xl" role="dialog" aria-modal="true" aria-label="Roles">
    <div class="flex items-center justify-between border-b border-line px-4 py-2">
      <h2 class="text-sm font-semibold text-text">Roles</h2>
      <button type="button" class="px-1 text-muted hover:text-text" aria-label="Close" onclick={onclose}>✕</button>
    </div>
    <div class="flex min-h-0 flex-1">
      <nav class="flex w-48 shrink-0 flex-col gap-1 overflow-y-auto border-r border-line p-2 text-sm" aria-label="Roles list">
        <button type="button" class={item(selected === null)} aria-current={selected === null ? 'true' : undefined} onclick={() => (selected = null)}>Shared rules</button>
        {#each roles as role (role.id)}
          <button type="button" class={item(selected === role.id)} aria-current={selected === role.id ? 'true' : undefined} onclick={() => (selected = role.id)}>{role.name}</button>
        {/each}
        <button type="button" class="rounded-md border border-line px-2 py-1.5 text-text hover:border-muted" onclick={addRole}>+ New role</button>
      </nav>
      {#key selected}
        <RolePane roleId={selected} ondelete={deleteRole} />
      {/key}
    </div>
  </div>
</div>
