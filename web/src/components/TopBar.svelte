<script lang="ts">
  import * as api from '$lib/api';
  import { live, type View } from '$lib/live.svelte';
  import SettingsDialog from './SettingsDialog.svelte';

  const TABS: { view: View; label: string }[] = [
    { view: 'brief', label: 'Brief' },
    { view: 'brainstorm', label: 'Brainstorm' },
    { view: 'flowchart', label: 'Flowchart' },
    { view: 'collaborate', label: 'Collaborate' },
  ];

  let menuOpen = $state(false);
  let settingsOpen = $state(false);
  let saveOpen = $state(false);
  let versionName = $state('');

  const saveStatus = $derived(live.saveStatus);

  function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : 'Something went wrong';
  }

  async function changeTitle(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const title = input.value.trim();
    if (!title) {
      input.value = live.board?.title ?? '';
      return;
    }
    if (title !== live.board?.title) await live.send({ type: 'setTitle', title });
  }

  async function step(action: 'undo' | 'redo'): Promise<void> {
    try {
      const { undone, skipped } = await api[action]();
      if (!undone) live.toast(action === 'undo' ? 'Nothing to undo' : 'Nothing to redo');
      else if (skipped.length) live.toast(`Kept ${skipped.length} item${skipped.length === 1 ? '' : 's'} you changed since.`);
    } catch (error) {
      live.toast(messageOf(error));
    }
  }

  async function saveVersion(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const name = versionName.trim();
    if (!name) return;
    try {
      const meta = await api.saveVersion(name);
      live.toast(`Saved version “${meta.name}”`);
      versionName = '';
      saveOpen = false;
    } catch (error) {
      live.toast(messageOf(error));
    }
  }

  async function exportDoc(): Promise<void> {
    menuOpen = false;
    try {
      live.toast(`Saved ${await api.exportDoc()}`);
    } catch (error) {
      live.toast(messageOf(error));
    }
  }

  /** "Version 2026-10-22 21:58", in local time. */
  function defaultVersionName(): string {
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `Version ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }

  function toggleSave(): void {
    saveOpen = !saveOpen;
    menuOpen = false;
    if (saveOpen) versionName = defaultVersionName();
  }

  /** Focuses the field and selects its text (the browser's autofocus is skipped when a button has focus). */
  function focusAll(node: HTMLInputElement): void {
    node.focus();
    node.select();
  }

  function closePopovers(event: MouseEvent): void {
    if (!(event.target as Element).closest('[data-popover]')) {
      menuOpen = false;
      saveOpen = false;
    }
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      menuOpen = false;
      saveOpen = false;
      return;
    }
    // Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo, except where the field's own undo should win.
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    const action = key === 'z' ? (event.shiftKey ? 'redo' : 'undo') : key === 'y' && !event.shiftKey ? 'redo' : null;
    if (!action) return;
    if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]')) return;
    event.preventDefault();
    void step(action);
  }

  const button = 'rounded-md border border-line bg-raised px-2.5 py-1 hover:border-muted';
</script>

<svelte:window onclick={closePopovers} {onkeydown} />

<header class="flex items-center gap-4 border-b border-line bg-panel px-4 py-2">
  <input
    class="w-56 rounded-md border border-transparent bg-transparent px-2 py-1 text-base font-semibold hover:border-line"
    aria-label="Board title"
    value={live.board?.title ?? ''}
    onchange={changeTitle}
    disabled={!live.board}
  />

  <div class="flex gap-1" role="tablist" aria-label="Views">
    {#each TABS as tab (tab.view)}
      <button
        role="tab"
        aria-selected={live.view === tab.view}
        class="rounded-md px-3 py-1 {live.view === tab.view ? 'bg-accent/25 text-text' : 'text-muted hover:text-text'}"
        onclick={() => (live.view = tab.view)}>{tab.label}</button>
    {/each}
  </div>

  <div class="ml-auto flex items-center gap-2">
    <span class="mr-2 text-xs {saveStatus === 'Not saved' ? 'text-rose-400' : 'text-muted'}" aria-live="polite">{saveStatus}</span>
    <button class={button} onclick={() => step('undo')}>↶ Undo</button>
    <button class={button} aria-label="Redo" title="Redo" onclick={() => step('redo')}>↷</button>

    <div class="relative" data-popover>
      <button class={button} aria-expanded={saveOpen} onclick={toggleSave}>★ Save version</button>
      {#if saveOpen}
        <form class="absolute right-0 z-40 mt-1 flex w-64 flex-col gap-2 rounded-md border border-line bg-raised p-3 shadow-lg" onsubmit={saveVersion}>
          <label class="text-xs text-muted" for="version-name">Name this version</label>
          <input id="version-name" class="rounded-md border border-line bg-ink px-2 py-1" bind:value={versionName} placeholder="e.g. Before the rewrite" use:focusAll />
          <button class="rounded-md bg-accent px-2.5 py-1 font-medium text-ink" disabled={!versionName.trim()}>Save</button>
        </form>
      {/if}
    </div>

    <div class="relative" data-popover>
      <button class={button} aria-label="More" aria-haspopup="menu" aria-expanded={menuOpen} onclick={() => { menuOpen = !menuOpen; saveOpen = false; }}>⋯</button>
      {#if menuOpen}
        <div class="absolute right-0 z-40 mt-1 w-48 rounded-md border border-line bg-raised py-1 shadow-lg" role="menu">
          <button class="block w-full px-3 py-1.5 text-left hover:bg-line" role="menuitem" onclick={exportDoc}>Export design doc</button>
          <button
            class="block w-full px-3 py-1.5 text-left hover:bg-line"
            role="menuitem"
            onclick={() => {
              menuOpen = false;
              settingsOpen = true;
            }}>Settings…</button
          >
        </div>
      {/if}
    </div>
  </div>
</header>

{#if settingsOpen}
  <SettingsDialog onclose={() => (settingsOpen = false)} />
{/if}
