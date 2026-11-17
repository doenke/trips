<script lang="ts">
  import { del, patch, post } from '../lib/api';
  import { TYPE_ICON, TYPE_LABEL } from '../lib/format';
  import type { Segment, SegmentInput, SegmentType } from '../lib/types';
  import Sheet from './Sheet.svelte';

  let { tripId, segment = null, onclose, onsaved }: { tripId: string; segment?: Segment | null; onclose: () => void; onsaved: () => void } = $props();

  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin';
  const zones: string[] = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];

  let type = $state<SegmentType>(segment?.type ?? 'flight');
  let f = $state({
    title: segment?.title ?? '',
    from_name: segment?.from_name ?? '',
    from_code: segment?.from_code ?? '',
    to_name: segment?.to_name ?? '',
    to_code: segment?.to_code ?? '',
    carrier: segment?.carrier ?? '',
    number: segment?.number ?? '',
    booking_ref: segment?.booking_ref ?? '',
    seat: segment?.seat ?? '',
    address: segment?.address ?? '',
    notes: segment?.notes ?? '',
    start_date: segment?.start_local?.slice(0, 10) ?? '',
    start_time: segment?.start_local?.slice(11, 16) ?? '',
    start_tz: segment?.start_tz ?? browserZone,
    end_date: segment?.end_local?.slice(0, 10) ?? '',
    end_time: segment?.end_local?.slice(11, 16) ?? '',
    end_tz: segment?.end_tz ?? segment?.start_tz ?? browserZone,
  });
  let busy = $state(false);
  let error = $state('');

  /** Labels per type; fields not listed are hidden. */
  const LABELS: Record<SegmentType, Partial<Record<string, string>>> = {
    flight: { number: 'Flugnummer', carrier: 'Airline', from_code: 'Von (IATA)', to_code: 'Nach (IATA)', start: 'Abflug', end: 'Ankunft', seat: 'Sitzplatz', booking_ref: 'Buchungsnummer' },
    train: { number: 'Zug', carrier: 'Bahn', from_name: 'Von', to_name: 'Nach', start: 'Abfahrt', end: 'Ankunft', seat: 'Wagen / Platz', booking_ref: 'Buchungsnummer' },
    hotel: { title: 'Hotel', address: 'Adresse', start: 'Check-in', end: 'Check-out', seat: 'Zimmer', booking_ref: 'Buchungsnummer' },
    car: { carrier: 'Vermieter', from_name: 'Abholung', to_name: 'Rückgabe', address: 'Adresse der Station', start: 'Abholung', end: 'Rückgabe', booking_ref: 'Buchungsnummer' },
    parking: { title: 'Parkhaus / Anbieter', address: 'Adresse', start: 'Einfahrt', end: 'Ausfahrt', seat: 'Stellplatz / Ebene', booking_ref: 'Buchungsnummer' },
    other: { title: 'Titel', address: 'Ort / Adresse', start: 'Beginn', end: 'Ende', booking_ref: 'Buchungsnummer' },
  };
  const L = $derived(LABELS[type]);
  const notesHint = $derived(type === 'parking' ? 'Kennzeichen, Shuttle, Zugang (Schranke, QR-Code, Telefonnummer) …' : '');

  const local = (d: string, t: string) => (d ? (t ? `${d}T${t}` : d) : null);
  const val = (v: string) => (v.trim() ? v.trim() : null);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = '';
    const has = (k: string) => k in L;
    const body: SegmentInput = {
      type,
      // Without a title field the server builds it from number, route or provider.
      title: (has('title') ? val(f.title) : null) as string,
      start_local: local(f.start_date, f.start_time),
      start_tz: f.start_date ? val(f.start_tz) : null,
      end_local: local(f.end_date, f.end_time),
      end_tz: f.end_date ? val(f.end_tz) : null,
      from_name: has('from_name') ? val(f.from_name) : null,
      from_code: has('from_code') ? val(f.from_code) : null,
      to_name: has('to_name') ? val(f.to_name) : null,
      to_code: has('to_code') ? val(f.to_code) : null,
      carrier: has('carrier') ? val(f.carrier) : null,
      number: has('number') ? val(f.number) : null,
      booking_ref: val(f.booking_ref),
      seat: has('seat') ? val(f.seat) : null,
      address: has('address') ? val(f.address) : null,
      notes: val(f.notes),
    };
    try {
      if (segment) await patch(`/api/segments/${segment.id}`, body);
      else await post(`/api/trips/${tripId}/segments`, body);
      onsaved();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function remove() {
    if (!segment || !confirm(`„${segment.title}“ löschen?`)) return;
    busy = true;
    try {
      await del(`/api/segments/${segment.id}`);
      onsaved();
    } catch (err) {
      error = (err as Error).message;
      busy = false;
    }
  }
</script>

<datalist id="zones">
  {#each zones as z (z)}<option value={z}></option>{/each}
</datalist>

<Sheet title={segment ? 'Eintrag bearbeiten' : 'Eintrag hinzufügen'} {onclose}>
  <form id="seg-form" onsubmit={submit}>
    <div class="types" role="radiogroup" aria-label="Art">
      {#each Object.keys(TYPE_LABEL) as t (t)}
        <button type="button" role="radio" aria-checked={type === t} class="type" onclick={() => (type = t as SegmentType)}>
          <span>{TYPE_ICON[t as SegmentType]}</span><span class="small">{TYPE_LABEL[t as SegmentType]}</span>
        </button>
      {/each}
    </div>

    {#if L.title}
      <div class="field"><label for="s-title">{L.title}</label><input id="s-title" bind:value={f.title} required maxlength="200" /></div>
    {/if}
    {#if L.number || L.carrier}
      <div class="field grid2">
        {#if L.number}<div class="field"><label for="s-number">{L.number}</label><input id="s-number" bind:value={f.number} placeholder={type === 'flight' ? 'LH 2010' : 'ICE 123'} /></div>{/if}
        {#if L.carrier}<div class="field"><label for="s-carrier">{L.carrier}</label><input id="s-carrier" bind:value={f.carrier} /></div>{/if}
      </div>
    {/if}
    {#if L.from_code}
      <div class="field grid2">
        <div class="field"><label for="s-fc">{L.from_code}</label><input id="s-fc" bind:value={f.from_code} maxlength="4" placeholder="DUS" autocapitalize="characters" /></div>
        <div class="field"><label for="s-tc">{L.to_code}</label><input id="s-tc" bind:value={f.to_code} maxlength="4" placeholder="PMI" autocapitalize="characters" /></div>
      </div>
    {/if}
    {#if L.from_name}
      <div class="field grid2">
        <div class="field"><label for="s-fn">{L.from_name}</label><input id="s-fn" bind:value={f.from_name} /></div>
        <div class="field"><label for="s-tn">{L.to_name}</label><input id="s-tn" bind:value={f.to_name} /></div>
      </div>
    {/if}
    {#if L.address}
      <div class="field"><label for="s-addr">{L.address}</label><input id="s-addr" bind:value={f.address} autocomplete="street-address" /></div>
    {/if}

    <fieldset class="when">
      <legend>{L.start}</legend>
      <div class="grid3">
        <input type="date" bind:value={f.start_date} aria-label="{L.start} Datum" />
        <input type="time" bind:value={f.start_time} aria-label="{L.start} Uhrzeit" />
        <input list="zones" bind:value={f.start_tz} aria-label="{L.start} Zeitzone" />
      </div>
    </fieldset>
    <fieldset class="when">
      <legend>{L.end}</legend>
      <div class="grid3">
        <input type="date" bind:value={f.end_date} min={f.start_date || undefined} aria-label="{L.end} Datum" />
        <input type="time" bind:value={f.end_time} aria-label="{L.end} Uhrzeit" />
        <input list="zones" bind:value={f.end_tz} aria-label="{L.end} Zeitzone" />
      </div>
    </fieldset>
    <p class="hint">Uhrzeiten immer in Ortszeit. Zeitzone als IANA-Name, z. B. Europe/Berlin.</p>

    <div class="field grid2">
      {#if L.booking_ref}<div class="field"><label for="s-ref">{L.booking_ref}</label><input id="s-ref" bind:value={f.booking_ref} autocapitalize="characters" /></div>{/if}
      {#if L.seat}<div class="field"><label for="s-seat">{L.seat}</label><input id="s-seat" bind:value={f.seat} /></div>{/if}
    </div>
    <div class="field"><label for="s-notes">Notizen</label><textarea id="s-notes" bind:value={f.notes} rows="3" placeholder={notesHint}></textarea></div>
    {#if error}<p class="error" style="margin-top:12px">{error}</p>{/if}
  </form>
  {#snippet footer()}
    {#if segment}<button type="button" class="danger" onclick={remove} disabled={busy} style="margin-right:auto">Löschen</button>{/if}
    <button type="button" onclick={onclose}>Abbrechen</button>
    <button class="primary" form="seg-form" disabled={busy}>Speichern</button>
  {/snippet}
</Sheet>

<style>
  .types {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 6px;
    margin-bottom: 16px;
  }
  .type {
    flex-direction: column;
    gap: 2px;
    min-height: 58px;
    padding: 4px;
    font-weight: 500;
    font-size: 1.2rem;
  }
  .type[aria-checked='true'] {
    background: var(--accent-soft);
    border-color: var(--accent);
  }
  @media (max-width: 420px) {
    .types {
      grid-template-columns: repeat(3, 1fr);
    }
  }
  .when {
    border: none;
    padding: 0;
    margin: 12px 0 0;
  }
  .when legend {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--ink-2);
    margin-bottom: 4px;
    padding: 0;
  }
  .grid3 {
    display: grid;
    grid-template-columns: 1.2fr 0.9fr 1.3fr;
    gap: 8px;
  }
  @media (max-width: 420px) {
    .grid3 {
      grid-template-columns: 1fr 1fr;
    }
    .grid3 input:last-child {
      grid-column: span 2;
    }
  }
</style>
