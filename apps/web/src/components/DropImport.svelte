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

  const target = $derived(app.dropTrip?.canEdit ? app.dropTrip : null);
  /** What the source offered, shown when a drop brought nothing usable (helps with new mail apps). */
  let received = $state<string[]>([]);

  /** Drags that start inside the page (text, links) and drops into form fields are left alone. */
  let internal = false;
  const editable = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest('input, textarea, [contenteditable="true"]');
  const ours = (e: DragEvent) => !internal && !!e.dataTransfer && !editable(e.target);

  /** Accept with an effect the source allows – Outlook may only offer "move", and "copy" would be refused. */
  function accept(e: DragEvent) {
    e.preventDefault();
    const dt = e.dataTransfer;
    if (!dt) return;
    const allowed = dt.effectAllowed;
    dt.dropEffect = /copy|all|uninitialized/i.test(allowed) ? 'copy' : /move/i.test(allowed) ? 'move' : /link/i.test(allowed) ? 'link' : 'copy';
  }

  async function send(form: FormData) {
    if (!app.me?.extraction) {
      error = 'Die automatische Auswertung ist auf diesem Server nicht eingerichtet (ANTHROPIC_API_KEY).';
      return;
    }
    busy = true;
    error = '';
    result = null;
    received = [];
    try {
      result = await api<ImportResult>(target ? `/api/trips/${target.id}/import` : '/api/import', { method: 'POST', body: form });
      app.importTick++;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  function htmlText(html: string): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, style').forEach((n) => n.remove());
    return (doc.body?.innerText || doc.body?.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  }

  /** Files win; otherwise the text the mail app hands over (the new Outlook gives no file). */
  async function handleDrop(dt: DataTransfer) {
    const files = [...dt.files];
    if (files.length) {
      const form = new FormData();
      for (const f of files) form.append('file', f, f.name);
      return send(form);
    }
    const types = [...dt.types];
    const html = types.includes('text/html') ? dt.getData('text/html') : '';
    const plain = types.includes('text/plain') ? dt.getData('text/plain') : '';
    const text = [plain.trim(), html ? htmlText(html) : ''].sort((a, b) => b.length - a.length)[0] ?? '';
    // A booking needs more than a subject line.
    if (text.length >= 200 || (text.includes('\n') && text.length >= 60)) {
      const form = new FormData();
      form.set('text', text);
      return send(form);
    }
    received = types.map((t) => {
      const v = t === 'Files' ? '' : dt.getData(t);
      return v ? `${t}: ${v.replace(/\s+/g, ' ').slice(0, 120)}${v.length > 120 ? ' …' : ''}` : t;
    });
    error = 'Dein Mailprogramm hat keine Mail-Datei und keinen Mailtext übergeben, nur das hier:';
  }

  onMount(() => {
    const start = () => (internal = true);
    const end = () => (internal = false);
    const enter = (e: DragEvent) => {
      if (!ours(e)) return;
      accept(e);
      depth++;
      dragging = true;
    };
    // Without preventDefault here the browser refuses the drop (red cursor) or opens the file itself.
    const over = (e: DragEvent) => {
      if (ours(e)) accept(e);
    };
    const leave = (e: DragEvent) => {
      if (!ours(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) dragging = false;
    };
    const drop = (e: DragEvent) => {
      if (!ours(e)) return;
      e.preventDefault();
      depth = 0;
      dragging = false;
      void handleDrop(e.dataTransfer!);
    };
    window.addEventListener('dragstart', start);
    window.addEventListener('dragend', end);
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragstart', start);
      window.removeEventListener('dragend', end);
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  });

  function close() {
    result = null;
    error = '';
    received = [];
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
      {#if received.length}
        <ul class="received small">
          {#each received as r, i (i)}<li><code>{r}</code></li>{/each}
        </ul>
        <p class="small">
          Was immer geht: die Mail an die Import-Adresse weiterleiten. Bietet dein Outlook <strong>Speichern unter</strong> (als .eml) an, kannst
          du auch die gespeicherte Datei hier hereinziehen.
        </p>
      {/if}
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
  .received {
    margin: 8px 0;
    padding-left: 18px;
    word-break: break-all;
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
