<script lang="ts">
  import { api } from '../lib/api';
  import type { ImportResult } from '../lib/types';
  import Sheet from './Sheet.svelte';

  let { tripId, onclose, ondone }: { tripId: string; onclose: () => void; ondone: () => void } = $props();

  let text = $state('');
  let file = $state<File | null>(null);
  let busy = $state(false);
  let error = $state('');
  let result = $state<ImportResult | null>(null);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = '';
    const form = new FormData();
    form.set('text', text);
    if (file) form.set('file', file, file.name);
    try {
      result = await api<ImportResult>(`/api/trips/${tripId}/import`, { method: 'POST', body: form });
      ondone();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<Sheet title="Buchung einfügen" {onclose}>
  {#if result}
    <pre class="summary">{result.summary}</pre>
  {:else}
    <form id="import-form" onsubmit={submit} class="stack">
      <p class="muted small">Text einer Buchungsbestätigung einfügen oder das PDF wählen. Claude liest die Buchung aus, die Einträge landen direkt in dieser Reise – Doppeltes wird aktualisiert, Stornos gelöscht.</p>
      <div class="field">
        <label for="imp-text">Buchungstext</label>
        <textarea id="imp-text" bind:value={text} rows="8" placeholder="Bestätigungsmail hier einfügen …"></textarea>
      </div>
      <div class="field">
        <label for="imp-file">oder PDF</label>
        <input id="imp-file" type="file" accept="application/pdf" onchange={(e) => (file = (e.currentTarget as HTMLInputElement).files?.[0] ?? null)} />
      </div>
      {#if busy}<p class="notice">Claude liest die Buchung … das dauert ein paar Sekunden.</p>{/if}
      {#if error}<p class="error">{error}</p>{/if}
    </form>
  {/if}
  {#snippet footer()}
    {#if result}
      <button class="primary" onclick={onclose}>Fertig</button>
    {:else}
      <button type="button" onclick={onclose}>Abbrechen</button>
      <button class="primary" form="import-form" disabled={busy || (text.trim().length < 20 && !file)}>Übernehmen</button>
    {/if}
  {/snippet}
</Sheet>

<style>
  .summary {
    white-space: pre-wrap;
    font-family: var(--font);
    background: var(--bg);
    border-radius: var(--radius-s);
    padding: 12px;
    margin: 0;
  }
</style>
