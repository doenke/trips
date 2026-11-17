<script lang="ts">
  import type { Snippet } from 'svelte';

  let { title, onclose, children, footer }: { title: string; onclose: () => void; children: Snippet; footer?: Snippet } = $props();
  let dialog: HTMLDialogElement;

  $effect(() => {
    dialog.showModal();
    return () => dialog.close();
  });
</script>

<dialog
  class="sheet"
  bind:this={dialog}
  oncancel={(e) => {
    e.preventDefault();
    onclose();
  }}
  onclick={(e) => {
    if (e.target === dialog) onclose();
  }}
>
  <div class="sheet-head">
    <h2>{title}</h2>
    <button class="icon ghost" type="button" aria-label="Schließen" onclick={onclose}>✕</button>
  </div>
  <div class="sheet-body">{@render children()}</div>
  {#if footer}<div class="sheet-foot">{@render footer()}</div>{/if}
</dialog>
