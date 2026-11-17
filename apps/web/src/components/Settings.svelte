<script lang="ts">
  import { onMount } from 'svelte';
  import { api, del, get, post, put } from '../lib/api';
  import { app, link, toast } from '../lib/state.svelte';
  import type { TokenInfo } from '../lib/types';
  import Avatar from './Avatar.svelte';

  interface MailLog {
    id: number;
    sender: string | null;
    subject: string | null;
    status: string;
    detail: string | null;
    trip_id: string | null;
    created_at: string;
  }

  const me = $derived(app.me!);
  let newEmail = $state('');
  let emailError = $state('');
  let airtrailKey = $state('');
  let airtrailBusy = $state(false);
  let airtrailError = $state('');
  let tokens = $state<TokenInfo[]>([]);
  let tokenName = $state('');
  let newToken = $state<string | null>(null);
  let mailLog = $state<MailLog[] | null>(null);
  let importResult = $state<string>('');

  const dateFmt = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  const fmt = (iso: string | null) => (iso ? dateFmt.format(new Date(iso.endsWith('Z') ? iso : `${iso}Z`)) : 'nie');

  async function loadTokens() {
    tokens = await get<TokenInfo[]>('/api/tokens').catch(() => []);
  }
  onMount(() => {
    void loadTokens();
    if (me.user.is_admin) void get<MailLog[]>('/api/admin/mail-log').then((r) => (mailLog = r)).catch(() => (mailLog = []));
  });

  async function copy(value: string, what: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast(`${what} kopiert`);
    } catch {
      toast('Kopieren ging nicht');
    }
  }

  async function addEmail(event: SubmitEvent) {
    event.preventDefault();
    emailError = '';
    try {
      const r = await post<{ alt_emails: string[] }>('/api/me/emails', { email: newEmail });
      app.me!.alt_emails = r.alt_emails;
      newEmail = '';
    } catch (err) {
      emailError = (err as Error).message;
    }
  }
  async function removeEmail(email: string) {
    const r = await del<{ alt_emails: string[] }>(`/api/me/emails/${encodeURIComponent(email)}`);
    app.me!.alt_emails = r.alt_emails;
  }

  async function rotateIcs() {
    if (!confirm('Neuen Kalender-Link erzeugen? Der alte funktioniert danach nicht mehr – Kalender-Abos müssen neu eingerichtet werden.')) return;
    const r = await post<{ ics_url: string }>('/api/me/ics/rotate');
    app.me!.ics_url = r.ics_url;
    toast('Neuer Link erzeugt');
  }

  async function saveAirtrail(event: SubmitEvent) {
    event.preventDefault();
    airtrailBusy = true;
    airtrailError = '';
    try {
      const r = await put<{ connected: boolean; status: string }>('/api/me/airtrail', { key: airtrailKey });
      app.me!.airtrail = { ...me.airtrail, connected: r.connected, status: r.status };
      airtrailKey = '';
      toast('AirTrail verbunden – deine Flüge werden übertragen');
    } catch (err) {
      airtrailError = (err as Error).message;
    } finally {
      airtrailBusy = false;
    }
  }
  async function checkAirtrail() {
    airtrailBusy = true;
    const r = await post<{ connected: boolean; status: string | null }>('/api/me/airtrail/check').finally(() => (airtrailBusy = false));
    app.me!.airtrail = { ...me.airtrail, connected: r.connected, status: r.status };
  }
  async function removeAirtrail() {
    if (!confirm('AirTrail-Key entfernen? Bereits übertragene Flüge bleiben in AirTrail.')) return;
    await del('/api/me/airtrail');
    app.me!.airtrail = { ...me.airtrail, connected: false, status: null };
  }

  async function createToken(event: SubmitEvent) {
    event.preventDefault();
    const r = await post<{ token: string }>('/api/tokens', { name: tokenName });
    newToken = r.token;
    tokenName = '';
    await loadTokens();
  }
  async function revoke(t: TokenInfo) {
    if (!confirm(t.kind === 'oauth' ? `Verbindung zu „${t.name}“ trennen?` : `Token „${t.name}“ widerrufen?`)) return;
    await del(`/api/tokens/${t.id}`);
    await loadTokens();
  }

  async function adminImport(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.set('file', file, file.name);
    try {
      const r = await api<{ created: { title: string; segments: number }[]; skipped: string[]; warnings: string[] }>('/api/admin/import', { method: 'POST', body: form });
      importResult = [
        `${r.created.length} Reisen importiert${r.created.length ? `: ${r.created.map((c) => `${c.title} (${c.segments})`).join(', ')}` : ''}`,
        r.skipped.length ? `${r.skipped.length} übersprungen (gab es schon)` : '',
        ...r.warnings,
      ]
        .filter(Boolean)
        .join('\n');
    } catch (err) {
      importResult = (err as Error).message;
    } finally {
      input.value = '';
    }
  }

  async function logout() {
    await post('/auth/logout').catch(() => undefined);
    navigator.serviceWorker?.controller?.postMessage({ type: 'logout' });
    app.me = null;
    history.replaceState(null, '', '/');
    app.path = '/';
  }

  const oauth = $derived(tokens.filter((t) => t.kind === 'oauth'));
  const pats = $derived(tokens.filter((t) => t.kind === 'pat'));
  const statusLabel: Record<string, string> = {
    imported: 'übernommen',
    nothing_to_do: 'nichts Neues',
    no_booking: 'keine Buchung',
    ignored: 'ignoriert',
    rejected: 'abgelehnt',
    error: 'Fehler',
    processing: 'läuft',
  };
</script>

<div class="page">
  <header class="topbar">
    <a class="button ghost icon" href="/" onclick={link} aria-label="Zurück">←</a>
    <h1 class="grow">Einstellungen</h1>
  </header>

  <section class="card pad row profile">
    <Avatar user={me.user} size={52} />
    <div class="grow">
      <div class="name">{me.user.name}{#if me.user.is_admin}<span class="badge">Admin</span>{/if}</div>
      <div class="small muted">{me.user.email ?? 'keine E-Mail'} · über {me.provider}</div>
    </div>
  </section>

  <p class="section-title">Buchungen per Mail</p>
  <section class="card pad stack">
    {#if me.import_address}
      <p>Leite Buchungsbestätigungen an <button class="copy" onclick={() => copy(me.import_address!, 'Adresse')}>{me.import_address}</button> weiter. Trips liest sie aus, sortiert sie in die passende Reise und schickt dir eine kurze Zusammenfassung.</p>
    {:else}
      <p class="muted">Der Mail-Import ist nicht eingerichtet.</p>
    {/if}
    <p class="small muted">Angenommen werden Mails von deiner Login-Adresse und diesen weiteren Adressen:</p>
    <ul class="plain">
      <li class="muted">{me.user.email ?? '–'} (Login)</li>
      {#each me.alt_emails as e (e)}
        <li class="row spread"><span>{e}</span><button class="chip" onclick={() => removeEmail(e)}>Entfernen</button></li>
      {/each}
    </ul>
    <form class="row" onsubmit={addEmail}>
      <input type="email" bind:value={newEmail} placeholder="weitere@adresse.de" aria-label="Weitere Absenderadresse" required />
      <button>Hinzufügen</button>
    </form>
    {#if emailError}<p class="error">{emailError}</p>{/if}
  </section>

  <p class="section-title">Kalender</p>
  <section class="card pad stack">
    <p class="small">Abonniere deine Reisen in Apple-, Google- oder Outlook-Kalender. Der Link ist geheim – wer ihn hat, sieht deine Reisen.</p>
    <code class="url">{me.ics_url}</code>
    <div class="row wrap">
      <button onclick={() => copy(me.ics_url, 'Kalender-Link')}>Kopieren</button>
      <a class="button" href={me.ics_url.replace(/^https?:/, 'webcal:')}>Abonnieren</a>
      <button class="ghost" onclick={rotateIcs}>Neu erzeugen</button>
    </div>
  </section>

  <p class="section-title">AirTrail</p>
  <section class="card pad stack">
    {#if !me.airtrail.enabled}
      <p class="muted small">AirTrail ist auf diesem Server nicht eingerichtet (AIRTRAIL_URL).</p>
    {:else}
      <p class="small">Deine Flüge landen automatisch in deinem AirTrail{me.airtrail.url ? ` (${me.airtrail.url})` : ''}. Den API-Key findest du dort unter Settings → Security.</p>
      {#if me.airtrail.connected}
        <p><strong>✓</strong> {me.airtrail.status ?? 'verbunden'}</p>
        <div class="row wrap">
          <button onclick={checkAirtrail} disabled={airtrailBusy}>Prüfen</button>
          <button class="danger" onclick={removeAirtrail}>Entfernen</button>
        </div>
      {/if}
      <form class="row" onsubmit={saveAirtrail}>
        <input type="password" bind:value={airtrailKey} placeholder={me.airtrail.connected ? 'Neuen Key eintragen' : 'AirTrail-API-Key'} aria-label="AirTrail-API-Key" autocomplete="off" required />
        <button class="primary" disabled={airtrailBusy}>Speichern</button>
      </form>
      {#if airtrailError}<p class="error">{airtrailError}</p>{/if}
    {/if}
  </section>

  <p class="section-title">Claude & Co. (MCP)</p>
  <section class="card pad stack">
    <p class="small">Füge in Claude (Einstellungen → Konnektoren) einen eigenen Konnektor mit dieser Adresse hinzu und melde dich mit {me.provider} an:</p>
    <div class="row"><code class="url grow">{me.mcp_url}</code><button onclick={() => copy(me.mcp_url, 'MCP-Adresse')}>Kopieren</button></div>
    <h2 class="sub">Verbundene Apps</h2>
    {#if !oauth.length}<p class="small muted">Noch keine.</p>{/if}
    {#each oauth as t (t.id)}
      <div class="row spread token">
        <div><strong>{t.name}</strong><div class="small muted">zuletzt benutzt: {fmt(t.last_used_at)}</div></div>
        <button class="danger" onclick={() => revoke(t)}>Trennen</button>
      </div>
    {/each}
    <h2 class="sub">Persönliche API-Tokens</h2>
    <p class="small muted">Für Skripte und Automationen: als <code>Authorization: Bearer …</code> für /mcp und die REST-API.</p>
    {#each pats as t (t.id)}
      <div class="row spread token">
        <div><strong>{t.name}</strong> <span class="mono small muted">{t.prefix}…</span><div class="small muted">zuletzt benutzt: {fmt(t.last_used_at)}</div></div>
        <button class="danger" onclick={() => revoke(t)}>Widerrufen</button>
      </div>
    {/each}
    {#if newToken}
      <div class="notice stack">
        <strong>Dein neues Token – es wird nur jetzt angezeigt:</strong>
        <code class="url">{newToken}</code>
        <div class="row"><button onclick={() => copy(newToken!, 'Token')}>Kopieren</button><button class="ghost" onclick={() => (newToken = null)}>Fertig</button></div>
      </div>
    {/if}
    <form class="row" onsubmit={createToken}>
      <input bind:value={tokenName} placeholder="Name, z. B. Home Assistant" aria-label="Name des Tokens" required maxlength="60" />
      <button>Anlegen</button>
    </form>
  </section>

  <p class="section-title">Deine Daten</p>
  <section class="card pad stack">
    <p class="small">Alle Reisen als JSON – zum Sichern oder Umziehen.</p>
    <a class="button" href="/api/export" download>Export herunterladen</a>
  </section>

  {#if me.user.is_admin}
    <p class="section-title">Admin</p>
    <section class="card pad stack">
      <h2 class="sub">JSON-Import</h2>
      <p class="small muted">Ein Export von Trips (oder ein TripIt-Dump). Reisen mit gleichem Titel und Startdatum werden übersprungen.</p>
      <label class="button">Datei wählen …<input type="file" accept="application/json,.json" hidden onchange={adminImport} /></label>
      {#if importResult}<pre class="small result">{importResult}</pre>{/if}
      <h2 class="sub">Mail-Import-Log</h2>
      {#if mailLog === null}
        <p class="small muted">Lädt …</p>
      {:else if !mailLog.length}
        <p class="small muted">Noch keine Mails.</p>
      {:else}
        <ul class="plain log">
          {#each mailLog as m (m.id)}
            <li>
              <div class="row spread"><strong class="small">{m.subject ?? '(ohne Betreff)'}</strong><span class="badge s-{m.status}">{statusLabel[m.status] ?? m.status}</span></div>
              <div class="small muted">{fmt(m.created_at)} · {m.sender ?? '?'}{#if m.trip_id} · <a href="/trips/{m.trip_id}" onclick={link}>Reise</a>{/if}</div>
              {#if m.detail && m.status !== 'imported'}<div class="small detail">{m.detail}</div>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  <div class="foot">
    <button onclick={logout}>Abmelden</button>
    <p class="small muted">Trips {me.version}</p>
  </div>
</div>

<style>
  .grow {
    flex: 1;
    min-width: 0;
  }
  .profile {
    gap: 14px;
  }
  .name {
    font-weight: 700;
    font-size: 1.1rem;
  }
  .badge {
    display: inline-block;
    font-size: 0.72rem;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
    margin-left: 8px;
    vertical-align: middle;
  }
  .s-error,
  .s-rejected {
    background: var(--danger-soft);
    color: var(--danger);
  }
  .s-ignored,
  .s-no_booking {
    background: var(--bg-2);
    color: var(--ink-3);
  }
  .plain {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .plain li {
    padding: 6px 0;
  }
  .url {
    display: block;
    font-family: var(--mono);
    font-size: 0.82rem;
    word-break: break-all;
    background: var(--bg);
    padding: 10px;
    border-radius: var(--radius-s);
  }
  .copy {
    min-height: 30px;
    padding: 0 8px;
    font-family: var(--mono);
    font-size: 0.9rem;
    background: var(--sun-soft);
    border-color: transparent;
  }
  .sub {
    font-size: 0.95rem;
    margin-top: 18px;
  }
  .token {
    border-top: 1px solid var(--line);
    padding-top: 10px;
  }
  .log li {
    border-top: 1px solid var(--line);
    padding: 10px 0;
  }
  .detail {
    white-space: pre-wrap;
    margin-top: 4px;
  }
  .result {
    white-space: pre-wrap;
    background: var(--bg);
    padding: 10px;
    border-radius: var(--radius-s);
  }
  .foot {
    text-align: center;
    margin-top: 32px;
  }
</style>
