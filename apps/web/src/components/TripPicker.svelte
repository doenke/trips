<script lang="ts">
  import { get } from '../lib/api';
  import { dateRange, daysBetween } from '../lib/format';
  import type { TripSummary } from '../lib/types';

  /** Pick one of the trips you may edit: closest to `near` first, with search. */
  let { value = $bindable(''), excludeId, near = '' }: { value?: string; excludeId: string; near?: string } = $props();

  let trips = $state<TripSummary[] | null>(null);
  let query = $state('');
  let error = $state('');

  const distance = (t: TripSummary) => {
    if (!near || !t.start_date) return 99999;
    const end = t.end_date ?? t.start_date;
    if (near >= t.start_date && near <= end) return 0;
    return Math.min(Math.abs(daysBetween(near, t.start_date)), Math.abs(daysBetween(near, end)));
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const q = query.trim();
    clearTimeout(timer);
    timer = setTimeout(
      async () => {
        try {
          const list = await get<TripSummary[]>(`/api/trips?filter=all${q ? `&q=${encodeURIComponent(q)}` : ''}`);
          trips = list.filter((t) => t.can_edit && t.id !== excludeId).sort((a, b) => distance(a) - distance(b));
        } catch (err) {
          error = (err as Error).message;
        }
      },
      q ? 250 : 0,
    );
    return () => clearTimeout(timer);
  });
</script>

<div class="field search">
  <input type="search" bind:value={query} placeholder="Reise suchen …" aria-label="Reise suchen" />
</div>
{#if error}
  <p class="error">{error}</p>
{:else if trips === null}
  <p class="muted small">Lädt …</p>
{:else if !trips.length}
  <p class="muted small">{query ? 'Keine passende Reise, die du ändern darfst.' : 'Keine andere Reise, die du ändern darfst.'}</p>
{:else}
  <div class="list">
    {#each trips.slice(0, 30) as t (t.id)}
      <label class="option" class:on={value === t.id}>
        <input type="radio" name="trip-picker" value={t.id} bind:group={value} />
        <span class="grow">
          <strong>{t.title}</strong>
          <span class="small muted">{[t.destination, dateRange(t.start_date, t.end_date)].filter(Boolean).join(' · ')}</span>
        </span>
      </label>
    {/each}
  </div>
{/if}

<style>
  .search {
    margin: 14px 0 8px;
  }
  .list {
    max-height: 40vh;
    overflow: auto;
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
</style>
