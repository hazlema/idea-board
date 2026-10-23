<script lang="ts">
  // The dashed orange frame on something Claude added, with Keep and Dismiss….
  // The parent must be positioned: the frame is drawn around it.
  interface Props {
    /** An object gets its buttons above the box; an entry gets them under its text. */
    variant: 'object' | 'entry';
    onkeep: () => void;
    /** Called with the reason (possibly empty) once the user has answered "Why not?". */
    ondismiss: (reason: string) => void;
  }

  let { variant, onkeep, ondismiss }: Props = $props();

  function dismiss(): void {
    const reason = window.prompt('Why not?');
    if (reason === null) return;
    ondismiss(reason.trim());
  }
</script>

<div
  class="pointer-events-none absolute border-2 border-dashed border-orange-400/80 {variant === 'object' ? '-inset-[7px] rounded-[16px]' : 'inset-0 rounded-lg'}"
  aria-hidden="true"
></div>
<div class="flex items-center gap-1.5 {variant === 'object' ? 'absolute bottom-full left-0 mb-2.5 rounded-md bg-ink/90 px-1.5 py-1 shadow' : 'mt-1.5'}">
  <span class="text-[11px] font-semibold text-orange-400"><span aria-hidden="true">✦ </span><span>Claude added</span></span>
  <button type="button" class="rounded-md border border-green-600 bg-green-600 px-2 py-px text-xs font-medium text-white hover:brightness-110" onclick={onkeep}>Keep</button>
  <button type="button" class="rounded-md border border-line bg-raised px-2 py-px text-xs hover:border-muted" onclick={dismiss}>Dismiss…</button>
</div>
