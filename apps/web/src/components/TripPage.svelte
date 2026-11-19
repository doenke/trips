<script lang="ts">
  import { onMount } from 'svelte';
  import { api, del, get } from '../lib/api';
  import { countdown, dateRange, dayLabel, fileSize, mapsLink, route } from '../lib/format';
  import { app, link, navigate, toast } from '../lib/state.svelte';
  import { groupByDay, timelineEntries } from '../lib/timeline';
  import type { Segment, Trip } from '../lib/types';
  import Avatars from './Avatars.svelte';
  import ImportDialog from './ImportDialog.svelte';
  import MergeDialog from './MergeDialog.svelte';
  import MoveDialog from './MoveDialog.svelte';
  import SegmentForm from './SegmentForm.svelte';
  import TripForm from './TripForm.svelte';

  let { id }: { id: string } = $props();

  let trip = $state<Trip | null>(null);
  let error = $state('');
  let open = $state<Record<string, boolean>>({});
  let editing = $state(false);
  let segmentForm = $state<{ segment: Segment | null } | null>(null);
  let importing = $state(false);
  let moving = $state<Segment | null>(null);
  let merging = $state(false);
  let uploading = $state(false);

  async function refresh() {
    try {
      trip = await get<Trip>(`/api/trips/${id}`);
      error = '';
    } catch (err) {
      error = (err as Error).message;
    }
  }
  onMount(() => {
    void refresh();
    return () => (app.dropTrip = null);
  });

  // A booking dropped while this trip is open lands here (DropImport); reload afterwards.
  $effect(() => {
    app.dropTrip = trip ? { id: trip.id, canEdit: trip.can_edit } : null;
  });
  let seenTick = app.importTick;
  $effect(() => {
    if (app.importTick !== seenTick) {
      seenTick = app.importTick;
      void refresh();
    }
  });

  // Pick up AirTrail results that arrive a moment after saving.
  $effect(() => {
    if (!trip) return;
    const timer = setTimeout(refresh, 4000);
    return () => clearTimeout(timer);
  });

  const groups = $derived(trip ? groupByDay(timelineEntries(trip.segments.filter((s) => s.start_local || s.end_local))) : []);
  const undated = $derived(trip ? trip.segments.filter((s) => !s.start_local && !s.end_local) : []);

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast(`„${value}“ kopiert`);
    } catch {
      toast('Kopieren ging nicht');
    }
  }

  async function removeTrip() {
    if (!trip || !confirm(`Reise „${trip.title}“ mit allen Einträgen und Anhängen löschen?`)) return;
    try {
      await del(`/api/trips/${trip.id}`);
      toast('Reise gelöscht');
      navigate('/', true);
    } catch (err) {
      toast((err as Error).message);
    }
  }

  /** Upload to the trip, or – with segmentId – to one entry. */
  async function upload(event: Event, segmentId?: string) {
    const input = event.currentTarget as HTMLInputElement;
    const files = input.files;
    if (!files?.length || !trip) return;
    uploading = true;
    const form = new FormData();
    if (segmentId) form.set('segment_id', segmentId);
    for (const f of files) form.append('file', f, f.name);
    try {
      await api(`/api/trips/${trip.id}/attachments`, { method: 'POST', body: form });
      toast('Angehängt');
      await refresh();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      uploading = false;
      input.value = '';
    }
  }

  async function removeAttachment(attachmentId: string, name: string) {
    if (!confirm(`„${name}“ löschen?`)) return;
    await del(`/api/attachments/${attachmentId}`).catch((err: Error) => toast(err.message));
    await refresh();
  }

  const filesOf = (segmentId: string) => trip?.attachments.filter((a) => a.segment_ids.includes(segmentId)) ?? [];
  const tripFiles = $derived(trip?.attachments.filter((a) => !a.segment_ids.length) ?? []);

  const nameOf = (userId: string) => trip?.travelers.find((u) => u.id === userId)?.name ?? app.users.find((u) => u.id === userId)?.name ?? '';
</script>

<div class="page">
  <header class="topbar">
    <a class="button ghost icon" href="/" onclick={link} aria-label="Zurück">←</a>
    <div class="grow"></div>
    {#if trip?.can_edit}
      <button class="ghost" onclick={() => (editing = true)}>Bearbeiten</button>
    {/if}
  </header>

  {#if error && !trip}
    <p class="error">{error}</p>
  {:else if !trip}
    <p class="muted">Lädt …</p>
  {:else}
    <section class="head">
      {#if trip.start_date}<span class="countdown">{countdown(trip.start_date, trip.end_date)}</span>{/if}
      <h1>{trip.title}</h1>
      <p class="muted">{[trip.destination, dateRange(trip.start_date, trip.end_date)].filter(Boolean).join(' · ')}</p>
      <div class="row travelers">
        <Avatars users={trip.travelers} size={32} />
        <span class="small muted">{trip.travelers.map((u) => u.name).join(', ')}</span>
      </div>
      {#if trip.notes}<p class="notes">{trip.notes}</p>{/if}
    </section>

    {#if trip.can_edit}
      <div class="actions">
        <button class="primary" onclick={() => (segmentForm = { segment: null })}>＋ Eintrag</button>
        {#if app.me?.extraction}<button onclick={() => (importing = true)}>📋 Buchung einfügen</button>{/if}
        <label class="button" class:busy={uploading}>
          📎 Anhang
          <input type="file" accept="application/pdf,image/*" multiple hidden onchange={upload} />
        </label>
      </div>
    {/if}

    {#if !trip.segments.length}
      <div class="card pad empty muted">
        Noch keine Einträge. {#if trip.can_edit}Füge einen hinzu oder leite die Buchungsbestätigung weiter.{/if}
      </div>
    {/if}

    {#snippet details(s: Segment)}
      <div class="details">
        {#if s.number || s.carrier}<div><span class="k">{s.type === 'flight' ? 'Flug' : s.type === 'train' ? 'Zug' : 'Anbieter'}</span>{[s.number, s.carrier].filter(Boolean).join(' · ')}</div>{/if}
        {#if route(s) && (s.type === 'flight' || s.type === 'train' || s.type === 'car')}<div><span class="k">Strecke</span>{[s.from_name && s.from_code ? `${s.from_name} (${s.from_code})` : (s.from_name ?? s.from_code), s.to_name && s.to_code ? `${s.to_name} (${s.to_code})` : (s.to_name ?? s.to_code)].filter(Boolean).join(' → ')}</div>{/if}
        {#if s.start_local}<div><span class="k">Beginn</span><span><span class="num">{dayLabel(s.start_local)}{s.start_local.length > 10 ? `, ${s.start_local.slice(11)}` : ''}</span>{#if s.start_tz}<br /><span class="muted small">{s.start_tz}</span>{/if}</span></div>{/if}
        {#if s.end_local}<div><span class="k">Ende</span><span><span class="num">{dayLabel(s.end_local)}{s.end_local.length > 10 ? `, ${s.end_local.slice(11)}` : ''}</span>{#if s.end_tz}<br /><span class="muted small">{s.end_tz}</span>{/if}</span></div>{/if}
        {#if s.booking_ref}<div><span class="k">Buchung</span><span><button class="copy mono" onclick={() => copy(s.booking_ref!)} title="Kopieren">{s.booking_ref} ⧉</button></span></div>{/if}
        {#if s.seat}<div><span class="k">{s.type === 'hotel' ? 'Zimmer' : s.type === 'parking' ? 'Stellplatz' : 'Platz'}</span>{s.seat}</div>{/if}
        {#if s.address}<div><span class="k">Adresse</span><a href={mapsLink(s.address)} target="_blank" rel="noopener">{s.address} ↗</a></div>{/if}
        {#if s.notes}<div><span class="k">Notizen</span><span class="pre">{s.notes}</span></div>{/if}
        {#each filesOf(s.id) as a (a.id)}
          <div>
            <span class="k">Anhang</span>
            <span class="file">
              <a href={a.url} target="_blank" rel="noopener">{a.mime === 'application/pdf' ? '📄' : '🖼️'} {a.filename}</a>
              <span class="small muted">{fileSize(a.size)}{a.segment_ids.length > 1 ? ` · auch bei ${a.segment_ids.length - 1} weiteren` : ''}</span>
              {#if trip!.can_edit}<button class="icon ghost small-icon" aria-label="Anhang löschen" onclick={() => removeAttachment(a.id, a.filename)}>🗑</button>{/if}
            </span>
          </div>
        {/each}
        {#if s.type === 'flight' && s.airtrail.users.length}
          <div class="small muted">In AirTrail: {s.airtrail.users.map(nameOf).join(', ')}</div>
        {/if}
        {#if s.airtrail.error}<div class="small warn">Nicht an AirTrail übertragen: {s.airtrail.error}</div>{/if}
        <div class="seg-foot small muted">
          <span>Quelle: {{ manual: 'von Hand', mail: 'Mail-Import', mcp: 'KI-Assistent', import: 'Import' }[s.source]}</span>
          {#if trip!.can_edit}
            <span class="seg-actions">
              <label class="button chip" class:busy={uploading}>
                📎 Anhang
                <input type="file" accept="application/pdf,image/*" multiple hidden onchange={(e) => upload(e, s.id)} />
              </label>
              <button class="chip" onclick={() => (moving = s)}>Verschieben</button>
              <button class="chip" onclick={() => (segmentForm = { segment: s })}>Bearbeiten</button>
            </span>
          {/if}
        </div>
      </div>
    {/snippet}

    {#each groups as g (g.day)}
      <h2 class="day">{dayLabel(g.day)}</h2>
      <ol class="timeline">
        {#each g.entries as e (e.key)}
          <li class="entry card" class:end={e.phase === 'end'}>
            <button class="entry-head" onclick={() => (open[e.key] = !open[e.key])} aria-expanded={!!open[e.key]}>
              <span class="time num">{e.time ?? ''}</span>
              <span class="icon">{e.icon}</span>
              <span class="text">
                {#if e.label && e.phase !== 'single'}<span class="label">{e.label}</span>{/if}
                <span class="title">{e.title}</span>
                {#if e.detail}<span class="detail small muted">{e.detail}</span>{/if}
              </span>
              {#if filesOf(e.segment.id).length}<span class="clip" title="{filesOf(e.segment.id).length} Anhang/Anhänge">📎{filesOf(e.segment.id).length > 1 ? filesOf(e.segment.id).length : ''}</span>{/if}
              {#if e.segment.airtrail.error}<span class="dot" title="Nicht an AirTrail übertragen"></span>{/if}
            </button>
            {#if open[e.key]}{@render details(e.segment)}{/if}
          </li>
        {/each}
      </ol>
    {/each}

    {#if undated.length}
      <h2 class="day">Ohne Datum</h2>
      <ol class="timeline">
        {#each undated as s (s.id)}
          <li class="entry card">
            <button class="entry-head" onclick={() => (open[s.id] = !open[s.id])} aria-expanded={!!open[s.id]}>
              <span class="time"></span><span class="icon">{({ flight: '✈️', train: '🚆', hotel: '🏨', car: '🚗', parking: '🅿️', other: '📌' })[s.type]}</span>
              <span class="text"><span class="title">{s.title}</span></span>
            </button>
            {#if open[s.id]}{@render details(s)}{/if}
          </li>
        {/each}
      </ol>
    {/if}

    {#if tripFiles.length}
      <p class="section-title">Anhänge zur ganzen Reise</p>
      <div class="card list">
        {#each tripFiles as a (a.id)}
          <div class="att">
            <a class="grow" href={a.url} target="_blank" rel="noopener">{a.mime === 'application/pdf' ? '📄' : '🖼️'} {a.filename}</a>
            <span class="small muted">{fileSize(a.size)}</span>
            {#if trip.can_edit}<button class="icon ghost" aria-label="Anhang löschen" onclick={() => removeAttachment(a.id, a.filename)}>🗑</button>{/if}
          </div>
        {/each}
      </div>
    {/if}

    {#if trip.can_edit}
      <div class="foot row wrap center">
        <button onclick={() => (merging = true)}>Mit anderer Reise zusammenführen</button>
        <button class="danger" onclick={removeTrip}>Reise löschen</button>
      </div>
    {:else}
      <p class="small muted foot">Nur Reisende und Admins können diese Reise ändern.</p>
    {/if}
  {/if}
</div>

{#if editing && trip}
  <TripForm {trip} onclose={() => (editing = false)} onsaved={(t) => { trip = t; editing = false; }} />
{/if}
{#if segmentForm && trip}
  <SegmentForm tripId={trip.id} segment={segmentForm.segment} onclose={() => (segmentForm = null)} onsaved={() => { segmentForm = null; void refresh(); }} />
{/if}
{#if merging && trip}
  <MergeDialog
    {trip}
    onclose={() => (merging = false)}
    onmerged={(target) => {
      merging = false;
      toast(`Zusammengeführt in „${target.title}“`);
      navigate(`/trips/${target.id}`, true);
    }}
  />
{/if}
{#if moving && trip}
  <MoveDialog
    segment={moving}
    fromTrip={trip}
    onclose={() => (moving = null)}
    onmoved={(target) => {
      moving = null;
      toast(`Verschoben nach „${target.title}“`);
      void refresh();
    }}
  />
{/if}
{#if importing && trip}
  <ImportDialog tripId={trip.id} onclose={() => (importing = false)} ondone={refresh} />
{/if}

<style>
  .grow {
    flex: 1;
    min-width: 0;
  }
  .head {
    padding: 4px 4px 8px;
  }
  .head h1 {
    margin-top: 8px;
    font-size: 1.85rem;
  }
  .head p {
    margin: 4px 0 0;
  }
  .countdown {
    font-weight: 700;
    font-size: 0.82rem;
    color: var(--accent);
    background: var(--accent-soft);
    padding: 4px 10px;
    border-radius: 999px;
  }
  .travelers {
    margin-top: 12px;
  }
  .notes {
    white-space: pre-wrap;
    background: var(--bg-2);
    padding: 10px 12px;
    border-radius: var(--radius-s);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 14px 0 6px;
  }
  .actions .busy {
    opacity: 0.6;
  }
  .empty {
    margin-top: 16px;
  }
  .day {
    margin: 26px 4px 10px;
    font-size: 0.95rem;
    color: var(--ink-2);
    position: sticky;
    top: 0;
    background: var(--bg);
    padding: 6px 0;
    z-index: 1;
  }
  .timeline {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .entry {
    margin-bottom: 8px;
    overflow: hidden;
  }
  .entry.end {
    background: var(--bg-2);
    box-shadow: none;
  }
  .entry-head {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    text-align: left;
    border: none;
    background: transparent;
    padding: 12px 14px;
    min-height: 56px;
    font-weight: 400;
    white-space: normal;
    border-radius: 0;
  }
  .time {
    width: 44px;
    flex: none;
    font-weight: 700;
    font-size: 0.95rem;
  }
  .icon {
    font-size: 1.25rem;
    flex: none;
  }
  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .title {
    font-weight: 650;
  }
  .label {
    color: var(--accent);
    font-weight: 700;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .seg-foot {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 4px;
  }
  .seg-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .clip {
    flex: none;
    font-size: 0.85rem;
    color: var(--ink-3);
  }
  .file {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
  }
  .small-icon {
    width: 32px;
    min-height: 32px;
    font-size: 0.95rem;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--sun);
    flex: none;
  }
  .details {
    border-top: 1px dashed var(--line);
    padding: 10px 14px 12px 68px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 0.93rem;
  }
  .details > div:not(.row) {
    display: grid;
    grid-template-columns: 84px 1fr;
    align-items: baseline;
    column-gap: 4px;
  }
  .details > div.small:not(.row) {
    display: block;
  }
  @media (max-width: 420px) {
    .details {
      padding-left: 14px;
    }
  }
  .k {
    display: inline-block;
    min-width: 84px;
    color: var(--ink-3);
    font-size: 0.82rem;
  }
  .pre {
    white-space: pre-wrap;
  }
  .copy {
    min-height: 32px;
    padding: 0 10px;
    border-radius: 8px;
    background: var(--sun-soft);
    border-color: transparent;
    font-weight: 700;
    letter-spacing: 0.04em;
  }
  .warn {
    color: var(--danger);
  }
  .list {
    overflow: hidden;
  }
  .att {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 8px 8px 16px;
    border-top: 1px solid var(--line);
  }
  .att:first-child {
    border-top: none;
  }
  .center {
    justify-content: center;
  }
  .foot {
    margin-top: 32px;
    text-align: center;
  }
</style>
