<script lang="ts">
  import * as api from '$lib/api';
  import { Draft } from '$lib/draft.svelte';
  import { live } from '$lib/live.svelte';
  import { colabState } from './colab.svelte';

  interface Props {
    /** A role id, or null for the shared rules. */
    roleId: string | null;
    ondelete: () => void;
  }

  let { roleId, ondelete }: Props = $props();

  const role = $derived(roleId === null ? undefined : colabState.library.roles.find((r) => r.id === roleId));
  const extras = () => live.board?.colab.extras ?? { rules: '', roles: {} };

  // Saves a change to the library; the server checks it and answers with the stored one.
  async function saveLibrary(patch: (library: typeof colabState.library) => typeof colabState.library): Promise<unknown> {
    try {
      const saved = await api.saveLibrary(patch(colabState.library));
      colabState.library = saved;
      return saved;
    } catch (error) {
      live.toast(error instanceof Error ? error.message : 'Could not save the roles');
      return null;
    }
  }

  const patchRole = (fields: { name?: string; job?: string; pictures?: true | undefined }) => (library: typeof colabState.library) => ({
    ...library,
    roles: library.roles.map((r) => {
      if (r.id !== roleId) return r;
      const next = { ...r, ...fields };
      if (!next.pictures) delete next.pictures;
      return next;
    }),
  });

  // The server replaces the whole extras object, so every save sends all of it.
  const saveExtra = (value: string): Promise<unknown> => {
    const current = extras();
    return live.send(
      roleId === null
        ? { type: 'setColabExtras', rules: value, roles: current.roles }
        : { type: 'setColabExtras', rules: current.rules, roles: { ...current.roles, [roleId]: value } },
    );
  };

  const name = new Draft({
    server: () => role?.name ?? '',
    save: (v) => (role ? saveLibrary(patchRole({ name: v })) : Promise.resolve({})),
    valid: (v) => v.trim() !== '',
    delay: 400,
  });
  const shared = new Draft({ server: () => colabState.library.rules, save: (v) => saveLibrary((l) => ({ ...l, rules: v })), delay: 500 });
  const job = new Draft({ server: () => role?.job ?? '', save: (v) => (role ? saveLibrary(patchRole({ job: v })) : Promise.resolve({})), delay: 500 });
  const extra = new Draft({
    server: () => (roleId === null ? extras().rules : (extras().roles[roleId] ?? '')),
    save: saveExtra,
    delay: 500,
  });

  const field = 'w-full resize-y rounded-md border border-line bg-ink px-2 py-1.5 text-text focus:border-accent';
</script>

<div class="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
  {#if roleId !== null && role}
    <label class="flex flex-col gap-1 text-muted"
      >Name
      <input type="text" maxlength="80" class={field} {...name.attrs} />
    </label>
    <label class="flex flex-col gap-1 text-muted"
      >Job, every board
      <textarea rows="8" class={field} {...job.attrs}></textarea>
    </label>
    <label class="flex items-center gap-2 text-muted">
      <input type="checkbox" checked={role.pictures === true} onchange={(e) => saveLibrary(patchRole({ pictures: e.currentTarget.checked ? true : undefined }))} />
      Can make pictures
    </label>
  {:else if roleId === null}
    <label class="flex flex-col gap-1 text-muted"
      >Rules, every board
      <textarea rows="8" class={field} {...shared.attrs}></textarea>
    </label>
  {/if}
  {#if roleId === null || role}
    <label class="flex flex-col gap-1 text-muted"
      >Extra for this board
      <textarea rows="4" class={field} {...extra.attrs}></textarea>
    </label>
  {/if}
  {#if role}
    <button
      type="button"
      class="self-start rounded-md border border-line px-2 py-1 text-muted hover:border-muted hover:text-text disabled:opacity-40"
      disabled={colabState.library.roles.length <= 1}
      onclick={ondelete}>Delete role</button
    >
  {/if}
</div>
