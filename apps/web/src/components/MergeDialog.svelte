<script lang="ts">
  import { post } from '../lib/api';
  import type { Trip } from '../lib/types';
  import Sheet from './Sheet.svelte';
  import TripPicker from './TripPicker.svelte';

  let { trip, onclose, onmerged }: { trip: Trip; onclose: () => void; onmerged: (target: Trip) => void } = $props();

  let target = $state('');
  let busy = $state(false);
  let error = $state('');

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = '';
    try {
      onmerged(await post<Trip>(`/api/trips/${trip.id}/merge`, { into: target }));
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<Sheet title="Reisen zusammenführen" {onclose}>
  <form id="merge-form" onsubmit={submit}>
    <p class="small">
      Alle Einträge, Anhänge und Reisenden von <strong>„{trip.title}“</strong> wandern in die Reise, die du hier wählst. Ihre Notizen
      werden angehängt, danach gibt es „{trip.title}“ nicht mehr.
    </p>
    <TripPicker bind:value={target} excludeId={trip.id} near={trip.start_date ?? ''} />
    {#if error}<p class="error">{error}</p>{/if}
  </form>
  {#snippet footer()}
    <button type="button" onclick={onclose}>Abbrechen</button>
    <button class="primary" form="merge-form" disabled={busy || !target}>Zusammenführen</button>
  {/snippet}
</Sheet>
