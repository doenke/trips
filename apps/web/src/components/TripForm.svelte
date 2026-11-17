<script lang="ts">
  import { patch, post } from '../lib/api';
  import { app } from '../lib/state.svelte';
  import type { Trip } from '../lib/types';
  import Avatar from './Avatar.svelte';
  import Sheet from './Sheet.svelte';

  let { trip = null, onclose, onsaved }: { trip?: Trip | null; onclose: () => void; onsaved: (t: Trip) => void } = $props();

  let title = $state(trip?.title ?? '');
  let destination = $state(trip?.destination ?? '');
  let start = $state(trip?.start_date ?? '');
  let end = $state(trip?.end_date ?? '');
  let notes = $state(trip?.notes ?? '');
  let travelers = $state<string[]>(trip ? trip.travelers.map((u) => u.id) : app.me ? [app.me.user.id] : []);
  let busy = $state(false);
  let error = $state('');

  function toggle(id: string) {
    travelers = travelers.includes(id) ? travelers.filter((x) => x !== id) : [...travelers, id];
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!travelers.length) {
      error = 'Mindestens eine Person muss mitreisen.';
      return;
    }
    busy = true;
    error = '';
    const body = { title, destination: destination || null, start_date: start || null, end_date: end || null, notes: notes || null, traveler_ids: travelers };
    try {
      const saved = trip ? await patch<Trip>(`/api/trips/${trip.id}`, body) : await post<Trip>('/api/trips', body);
      onsaved(saved);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<Sheet title={trip ? 'Reise bearbeiten' : 'Neue Reise'} {onclose}>
  <form id="trip-form" onsubmit={submit}>
    <div class="field">
      <label for="t-title">Titel</label>
      <input id="t-title" bind:value={title} required maxlength="200" placeholder="z. B. Mallorca im Juli" />
    </div>
    <div class="field">
      <label for="t-dest">Ziel</label>
      <input id="t-dest" bind:value={destination} maxlength="200" placeholder="Stadt oder Region" />
    </div>
    <div class="field grid2">
      <div class="field">
        <label for="t-start">Von</label>
        <input id="t-start" type="date" bind:value={start} />
      </div>
      <div class="field">
        <label for="t-end">Bis</label>
        <input id="t-end" type="date" bind:value={end} min={start || undefined} />
      </div>
    </div>
    <p class="hint">Die Daten wachsen automatisch mit, wenn Buchungen außerhalb liegen.</p>
    <div class="field">
      <span class="label">Wer reist mit?</span>
      <div class="people">
        {#each app.users as u (u.id)}
          <button type="button" class="person" aria-pressed={travelers.includes(u.id)} onclick={() => toggle(u.id)}>
            <Avatar user={u} size={28} />
            <span>{u.name}</span>
          </button>
        {/each}
      </div>
      <p class="hint">Reisende (und Admins) dürfen die Reise ändern. Lesen können alle.</p>
    </div>
    <div class="field">
      <label for="t-notes">Notizen</label>
      <textarea id="t-notes" bind:value={notes} rows="3"></textarea>
    </div>
    {#if error}<p class="error" style="margin-top:12px">{error}</p>{/if}
  </form>
  {#snippet footer()}
    <button type="button" onclick={onclose}>Abbrechen</button>
    <button class="primary" form="trip-form" disabled={busy || !title.trim()}>{trip ? 'Speichern' : 'Anlegen'}</button>
  {/snippet}
</Sheet>

<style>
  .label {
    display: block;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--ink-2);
    margin-bottom: 6px;
  }
  .people {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .person {
    min-height: 40px;
    padding: 0 12px 0 4px;
    border-radius: 999px;
    font-weight: 500;
  }
  .person[aria-pressed='true'] {
    background: var(--accent-soft);
    border-color: var(--accent);
  }
</style>
