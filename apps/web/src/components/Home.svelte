<script lang="ts">
  import { get } from '../lib/api';
  import { countdown, dateRange, dayLabel, timeOf, TYPE_ICON } from '../lib/format';
  import { app, link, load, navigate, save } from '../lib/state.svelte';
  import type { Trip, TripSummary } from '../lib/types';
  import Avatar from './Avatar.svelte';
  import Avatars from './Avatars.svelte';
  import TripForm from './TripForm.svelte';

  let { creating = false }: { creating?: boolean } = $props();

  let mine = $state(load<boolean>('mine', true));
  let upcoming = $state<TripSummary[] | null>(null);
  let past = $state<TripSummary[] | null>(null);
  let pastOpen = $state(false);
  let error = $state('');

  async function refresh() {
    error = '';
    try {
      upcoming = await get<TripSummary[]>(`/api/trips?filter=upcoming&mine=${mine}`);
      if (pastOpen) past = await get<TripSummary[]>(`/api/trips?filter=past&mine=${mine}`);
      void keepOffline(upcoming);
    } catch (err) {
      error = (err as Error).message;
    }
  }

  /** Loads upcoming trips once more in the background, so the service worker has them – and their PDFs – offline. */
  async function keepOffline(list: TripSummary[]) {
    if (!navigator.serviceWorker?.controller) return;
    const urls: string[] = [];
    for (const t of list.slice(0, 12)) {
      const trip = await get<Trip>(`/api/trips/${t.id}`).catch(() => null);
      if (trip) urls.push(...trip.attachments.map((a) => a.url));
    }
    if (urls.length) navigator.serviceWorker.controller.postMessage({ type: 'precache', urls });
  }

  $effect(() => {
    save('mine', mine);
    void app.importTick; // reload after a dropped booking
    void refresh();
  });

  async function togglePast(event: Event) {
    pastOpen = (event.currentTarget as HTMLDetailsElement).open;
    if (pastOpen && !past) past = await get<TripSummary[]>(`/api/trips?filter=past&mine=${mine}`).catch(() => []);
  }

  const next = $derived(upcoming?.[0] ?? null);
  const later = $derived(upcoming?.slice(1) ?? []);
  const pastByYear = $derived.by(() => {
    const groups = new Map<string, TripSummary[]>();
    for (const t of past ?? []) {
      const y = t.start_date?.slice(0, 4) ?? 'Ohne Datum';
      groups.set(y, [...(groups.get(y) ?? []), t]);
    }
    return [...groups.entries()];
  });
</script>

<div class="page">
  <header class="topbar">
    <a class="brand grow" href="/" onclick={link}><img src="/icon-192.png" alt="" /> Trips</a>
    <a href="/settings" onclick={link} aria-label="Einstellungen" class="me">
      {#if app.me}<Avatar user={app.me.user} size={36} />{/if}
    </a>
  </header>

  <div class="row spread wrap">
    <div class="row" role="group" aria-label="Filter">
      <button class="chip" aria-pressed={mine} onclick={() => (mine = true)}>Meine</button>
      <button class="chip" aria-pressed={!mine} onclick={() => (mine = false)}>Alle</button>
    </div>
    <a class="button primary" href="/trips/new" onclick={link}>＋ Neue Reise</a>
  </div>

  {#if error}<p class="error" style="margin-top:16px">{error}</p>{/if}

  {#if upcoming === null}
    <p class="muted" style="margin-top:24px">Lädt …</p>
  {:else if !next}
    <div class="card pad empty">
      <h2>Noch keine kommende Reise</h2>
      <p class="muted">
        Leg eine Reise an – oder leite einfach eine Buchungsbestätigung
        {#if app.me?.import_address}an <strong>{app.me.import_address}</strong>{:else}an das Import-Postfach{/if} weiter – oder zieh die Mail direkt aus Outlook in dieses Fenster. Trips sortiert sie selbst ein.
      </p>
    </div>
  {:else}
    <p class="section-title">Nächste Reise</p>
    <a class="card hero" href="/trips/{next.id}" onclick={link}>
      <div class="hero-top">
        <span class="countdown">{countdown(next.start_date, next.end_date)}</span>
        <Avatars users={next.travelers} size={30} />
      </div>
      <h1>{next.title}</h1>
      <p class="muted">{[next.destination, dateRange(next.start_date, next.end_date)].filter(Boolean).join(' · ')}</p>
      {#if next.next_segment}
        {@const s = next.next_segment}
        <div class="next-seg">
          <span class="seg-icon">{TYPE_ICON[s.type]}</span>
          <div class="grow">
            <div class="seg-title">{s.title}</div>
            <div class="small muted num">
              {s.start_local ? dayLabel(s.start_local) : ''}{timeOf(s.start_local) ? ` · ${timeOf(s.start_local)}` : ''}{s.seat ? ` · ${s.type === 'hotel' ? 'Zimmer' : s.type === 'parking' ? 'Stellplatz' : 'Platz'} ${s.seat}` : ''}
            </div>
          </div>
        </div>
      {/if}
    </a>

    {#if later.length}
      <p class="section-title">Danach</p>
      <div class="list card">
        {#each later as t (t.id)}
          <a class="item" href="/trips/{t.id}" onclick={link}>
            <div class="grow">
              <div class="item-title">{t.title}</div>
              <div class="small muted">{[t.destination, dateRange(t.start_date, t.end_date)].filter(Boolean).join(' · ')}</div>
            </div>
            <Avatars users={t.travelers} size={24} />
          </a>
        {/each}
      </div>
    {/if}
  {/if}

  <details class="past" ontoggle={togglePast}>
    <summary class="section-title">Vergangene Reisen</summary>
    {#if past === null}
      <p class="muted small">Lädt …</p>
    {:else if !past.length}
      <p class="muted small">Noch keine.</p>
    {:else}
      {#each pastByYear as [year, trips] (year)}
        <h3 class="year">{year}</h3>
        <div class="list card">
          {#each trips as t (t.id)}
            <a class="item" href="/trips/{t.id}" onclick={link}>
              <div class="grow">
                <div class="item-title">{t.title}</div>
                <div class="small muted">{[t.destination, dateRange(t.start_date, t.end_date)].filter(Boolean).join(' · ')}</div>
              </div>
              <Avatars users={t.travelers} size={22} />
            </a>
          {/each}
        </div>
      {/each}
    {/if}
  </details>
</div>

{#if creating}
  <TripForm
    onclose={() => navigate('/', true)}
    onsaved={(t) => navigate(`/trips/${t.id}`, true)}
  />
{/if}

<style>
  .me {
    display: inline-flex;
  }
  .empty {
    margin-top: 24px;
  }
  .empty p {
    margin-bottom: 0;
  }
  .hero {
    display: block;
    color: inherit;
    padding: 18px;
    position: relative;
    overflow: hidden;
    background:
      radial-gradient(120% 90% at 100% 0%, var(--accent-soft) 0%, transparent 60%),
      var(--card);
  }
  .hero-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  .countdown {
    font-weight: 700;
    font-size: 0.85rem;
    color: var(--accent);
    background: var(--accent-soft);
    padding: 4px 10px;
    border-radius: 999px;
  }
  .hero h1 {
    font-size: 1.75rem;
  }
  .hero p {
    margin: 4px 0 0;
  }
  .next-seg {
    display: flex;
    gap: 12px;
    align-items: center;
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px dashed var(--line);
  }
  .seg-icon {
    font-size: 1.4rem;
  }
  .seg-title {
    font-weight: 650;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .list {
    overflow: hidden;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
    color: inherit;
    border-top: 1px solid var(--line);
  }
  .item:first-child {
    border-top: none;
  }
  .item-title {
    font-weight: 650;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .past summary {
    cursor: pointer;
    list-style: none;
  }
  .past summary::after {
    content: ' ▸';
  }
  .past[open] summary::after {
    content: ' ▾';
  }
  .year {
    font-size: 0.95rem;
    margin: 16px 4px 8px;
    color: var(--ink-2);
  }
</style>
