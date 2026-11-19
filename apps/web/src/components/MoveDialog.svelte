<script lang="ts">
  import { post } from '../lib/api';
  import { TYPE_ICON } from '../lib/format';
  import type { Segment, Trip } from '../lib/types';
  import Sheet from './Sheet.svelte';
  import TripPicker from './TripPicker.svelte';

  let { segment, fromTrip, onclose, onmoved }: { segment: Segment; fromTrip: Trip; onclose: () => void; onmoved: (target: Trip) => void } = $props();

  let choice = $state('');
  let asNew = $state(false);
  // "Wien" or "Reise nach VIE" reads better as a trip title than "EW 9754 DUS → VIE".
  let newTitle = $state(segment.to_name ?? (segment.to_code ? `Reise nach ${segment.to_code}` : segment.title));
  let busy = $state(false);
  let error = $state('');

  $effect(() => {
    if (choice) asNew = false;
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = '';
    try {
      const body = asNew ? { new_trip_title: newTitle } : { trip_id: choice };
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

    <label class="option" class:on={asNew}>
      <input
        type="radio"
        name="new-trip"
        checked={asNew}
        onchange={() => {
          asNew = true;
          choice = '';
        }}
      />
      <span class="grow">
        <strong>Neue Reise</strong>
        <span class="small muted">mit denselben Reisenden</span>
      </span>
    </label>
    {#if asNew}
      <div class="field newtitle">
        <label for="move-title">Titel der neuen Reise</label>
        <input id="move-title" bind:value={newTitle} required maxlength="200" />
      </div>
    {/if}

    <TripPicker bind:value={choice} excludeId={fromTrip.id} near={(segment.start_local ?? segment.end_local ?? '').slice(0, 10)} />
    {#if error}<p class="error">{error}</p>{/if}
  </form>
  {#snippet footer()}
    <button type="button" onclick={onclose}>Abbrechen</button>
    <button class="primary" form="move-form" disabled={busy || (!choice && !asNew) || (asNew && !newTitle.trim())}>Verschieben</button>
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
</style>
