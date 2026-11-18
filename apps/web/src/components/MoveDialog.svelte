<script lang="ts">
  import { get, post } from '../lib/api';
  import { dateRange, daysBetween, TYPE_ICON } from '../lib/format';
  import type { Segment, Trip, TripSummary } from '../lib/types';
  import Sheet from './Sheet.svelte';

  let { segment, fromTrip, onclose, onmoved }: { segment: Segment; fromTrip: Trip; onclose: () => void; onmoved: (target: Trip) => void } = $props();

  let trips = $state<TripSummary[] | null>(null);
  let query = $state('');
  let choice = $state<string>('');
  // "Wien" or "Reise nach VIE" reads better as a trip title than "EW 9754 DUS → VIE".
  let newTitle = $state(segment.to_name ?? (segment.to_code ? `Reise nach ${segment.to_code}` : segment.title));
  let busy = $state(false);
  let error = $state('');

  const day = (segment.start_local ?? segment.end_local ?? '').slice(0, 10);
  /** Days between the segment and a trip – the closest trips come first. */
  const distance = (t: TripSummary) => {
    if (!day || !t.start_date) return 99999;
    const end = t.end_date ?? t.start_date;
    if (day >= t.start_date && day <= end) return 0;
    return Math.min(Math.abs(daysBetween(day, t.start_date)), Math.abs(daysBetween(day, end)));
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const q = query.trim();
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const list = await get<TripSummary[]>(`/api/trips?filter=all${q ? `&q=${encodeURIComponent(q)}` : ''}`);
        trips = list.filter((t) => t.can_edit && t.id !== fromTrip.id).sort((a, b) => distance(a) - distance(b));
      } catch (err) {
        error = (err as Error).message;
      }
    }, q ? 250 : 0);
    return () => clearTimeout(timer);
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = '';
    try {
      const body = choice === 'new' ? { new_trip_title: newTitle } : { trip_id: choice };
      const r = await post<{ trip: Trip }>(`/api/segments/${segment.id}/move`, body);
      onmoved(r.trip);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<Sheet title="Eintrag verschieben" {onclose}>
  <form id="move-form" onsubmit={submit}>
    <p class="what">{TYPE_ICON[segment.type]} <strong>{segment.title}</strong> aus „{fromTrip.title}“</p>

    <label class="option" class:on={choice === 'new'}>
      <input type="radio" name="target" value="new" bind:group={choice} />
      <span class="grow">
        <strong>Neue Reise</strong>
        <span class="small muted">mit denselben Reisenden</span>
      </span>
    </label>
    {#if choice === 'new'}
      <div class="field newtitle">
        <label for="move-title">Titel der neuen Reise</label>
        <input id="move-title" bind:value={newTitle} required maxlength="200" />
      </div>
    {/if}

    <div class="field search">
      <input type="search" bind:value={query} placeholder="Reise suchen …" aria-label="Reise suchen" />
    </div>
    {#if trips === null}
      <p class="muted small">Lädt …</p>
    {:else if !trips.length}
      <p class="muted small">{query ? 'Keine passende Reise, die du ändern darfst.' : 'Keine andere Reise, die du ändern darfst.'}</p>
    {:else}
      <div class="list">
        {#each trips.slice(0, 30) as t (t.id)}
          <label class="option" class:on={choice === t.id}>
            <input type="radio" name="target" value={t.id} bind:group={choice} />
            <span class="grow">
              <strong>{t.title}</strong>
              <span class="small muted">{[t.destination, dateRange(t.start_date, t.end_date)].filter(Boolean).join(' · ')}</span>
            </span>
          </label>
        {/each}
      </div>
    {/if}
    {#if error}<p class="error">{error}</p>{/if}
  </form>
  {#snippet footer()}
    <button type="button" onclick={onclose}>Abbrechen</button>
    <button class="primary" form="move-form" disabled={busy || !choice || (choice === 'new' && !newTitle.trim())}>Verschieben</button>
  {/snippet}
</Sheet>

<style>
  .what {
    margin: 0 0 14px;
  }
  .option {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    margin: 0 0 6px;
    cursor: pointer;
    font-weight: 400;
    color: var(--ink);
  }
  .option.on {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .option input {
    width: auto;
    min-height: 0;
    accent-color: var(--accent);
  }
  .grow {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .newtitle {
    margin: 4px 0 12px;
  }
  .search {
    margin: 14px 0 8px;
  }
  .list {
    max-height: 40vh;
    overflow: auto;
  }
</style>
