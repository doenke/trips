<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import { app, navigate } from '../lib/state.svelte';
  import type { ImportResult } from '../lib/types';
  import Sheet from './Sheet.svelte';

  /**
   * Drop a booking anywhere in the app: a mail dragged out of Outlook (.msg on Windows, .eml on the
   * Mac), Thunderbird or Apple Mail, or a PDF. On a trip you may edit it goes into that trip,
   * elsewhere Trips finds the trip itself – like the mail import.
   */
  let dragging = $state(false);
  let busy = $state(false);
  let result = $state<ImportResult | null>(null);
  let error = $state('');
  let depth = 0;

  const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  const target = $derived(app.dropTrip?.canEdit ? app.dropTrip : null);

  async function upload(files: File[]) {
    if (!app.me?.extraction) {
      error = 'Die automatische Auswertung ist auf diesem Server nicht eingerichtet (ANTHROPIC_API_KEY).';
      return;
    }
    busy = true;
    error = '';
    result = null;
    const form = new FormData();
    for (const f of files) form.append('file', f, f.name);
    try {
      result = await api<ImportResult>(target ? `/api/trips/${target.id}/import` : '/api/import', { method: 'POST', body: form });
      app.importTick++;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      dragging = true;
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      // Without this the browser would open the file instead of handing it to the app.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) dragging = false;
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      dragging = false;
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) void upload(files);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  });

  function close() {
    result = null;
    error = '';
  }

  function openTrip() {
    const id = result?.trip?.id;
    close();
    if (id) navigate(`/trips/${id}`);
  }
</script>

{#if dragging}
  <div class="overlay" aria-hidden="true">
    <div class="target">
      <div class="icon">📥</div>
      <strong>Buchung hier ablegen</strong>
      <span class="small">
        E-Mail aus Outlook, Apple Mail oder Thunderbird – oder ein PDF.<br />
        {#if target}Landet in dieser Reise.{:else}Trips sucht die passende Reise selbst.{/if}
      </span>
    </div>
  </div>
{/if}

{#if busy || result || error}
  <Sheet title="Buchung übernehmen" onclose={close}>
    {#if busy}
      <p class="notice">Claude liest die Buchung … das dauert ein paar Sekunden.</p>
    {:else if error}
      <p class="error">{error}</p>
    {:else if result}
      <pre class="summary">{result.summary}</pre>
    {/if}
    {#snippet footer()}
      {#if result?.trip && result.trip.id !== app.dropTrip?.id}
        <button onclick={close}>Schließen</button>
        <button class="primary" onclick={openTrip}>Zur Reise</button>
      {:else}
        <button class="primary" onclick={close} disabled={busy}>Fertig</button>
      {/if}
    {/snippet}
  </Sheet>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: color-mix(in srgb, var(--bg) 80%, transparent);
    backdrop-filter: blur(3px);
    pointer-events: none;
  }
  .target {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    text-align: center;
    padding: 36px 40px;
    max-width: 440px;
    border: 3px dashed var(--accent);
    border-radius: 24px;
    background: var(--card);
    box-shadow: var(--shadow);
  }
  .icon {
    font-size: 2.4rem;
  }
  .target strong {
    font-size: 1.2rem;
  }
  .summary {
    white-space: pre-wrap;
    font-family: var(--font);
    background: var(--bg);
    border-radius: var(--radius-s);
    padding: 12px;
    margin: 0;
  }
</style>
