# Trips – Hinweise für Claude

Schlanke, selbst gehostete Reise-App (TripIt-Ersatz): Buchungen per Mail, Zeitleiste, ICS, AirTrail, MCP.
Bewusst klein – keine Karten, POIs, Tagesplanung, Packlisten, Budget, Kommentare, Echtzeit, n8n.

## Arbeitsweise

- Antworten an den Nutzer auf Deutsch; direkt auf `main` arbeiten, kleine Commits.
- **Sprache:** Alles, was Nutzer sehen (UI, Fehlermeldungen, Mails, MCP-Texte, README), ist Deutsch.
  Code, Bezeichner und Kommentare sind Englisch.
- **README bei jeder Funktionsänderung mitpflegen** (Stil: duzen, warm, konkret, ehrlich über Grenzen).
- Keine persönlichen Domains in Repo-Dateien: `example.org` in Beispielen.
- Keine CDNs, keine externen Webfonts.

## Versionierung x.yy.zzz

- `x` – Hauptversion, nur von Hand in `versions.json` (`major`). Bei neuer Hauptversion `since` auf den Tag setzen.
- `yy` – Tage (Europe/Berlin) seit `since`, an denen sich `paths` aus `versions.json` geändert haben. Automatisch.
- `zzz` – `GITHUB_RUN_NUMBER`, lokal `0`.
- Berechnung: `node scripts/version.mjs app`. CI braucht `fetch-depth: 0`.
- Neue Ordner der App → `paths` ergänzen. Nach einem Push die Version aus der CI-Zusammenfassung nennen.

## Landkarte

pnpm-Monorepo: `apps/server` (Fastify 5, node:sqlite, TypeScript 7), `apps/web` (Svelte 5 + Vite, TypeScript 6 wegen svelte-check).

- **Eine Service-Schicht** `apps/server/src/service/`: REST (`api/routes.ts`), MCP (`mcp/server.ts`) und
  Mail-Import (`mail/processor.ts`) rufen nur diese Funktionen auf. Nichts duplizieren.
  - `trips.ts` – Reisen, Segmente, Rechte (`canEdit`: Reisende oder Admin; lesen dürfen alle), Datumserweiterung, Hooks,
    Suche (`listTrips({ query })`, alle Wörter, Umlaute egal), `moveSegment` (Ziel oder neue Reise, Anhänge mit, alte Reise schrumpft),
    `mergeTrips` (alles in die Zielreise, doppelte Dateien einmal, Quelle wird gelöscht – Dateien danach mit `removeFiles` entfernen).
  - `booking.ts` – Extraktion → Zuordnung → Duplikate/Stornos → Mitreisende → Anhänge → Zusammenfassung.
  - `matching.ts` – `pickTrip`/`fitsTrip` (±`TRIP_MATCH_DAYS`; hat die Reise eine Rückreise zum Startort (`returnDay`),
    nur noch Beginn bis einschließlich Rückreisetag, ab Starttag − 1), meiste gemeinsame Reisende, dann nächstgelegen; `sameSegment`.
  - `names.ts` – toleranter Passagier-Abgleich. `users.ts` – Konten, Zusatz-Absenderadressen, ICS-Token, AirTrail-Key.
  - `schemas.ts` – zod-Schemas für REST *und* MCP (snake_case), deutsche zod-Meldungen.
  - `exchange.ts` – JSON-Export/-Import; `tripit.ts` – TripIt-Dump → Exportformat (UTC → Ortszeit über
    Flughafen-Zonen; Hotels über die lokale Uhrzeit; Mietwagen-Paare; Bahn). Echte Dumps nie ins Repo – Tests nutzen ausgedachte Daten.
- `airports.ts` + `data/airport-zones.json` – IATA → IANA-Zone (mwgg/Airports, MIT). Flüge ohne Zone bekommen sie daraus.
- `extract/claude.ts` – Structured Outputs (kein erzwungener Tool-Call: Sonnet 5.5 lehnt `tool_choice: tool` ab), PDFs als `document`-Blöcke.
  Die API erlaubt höchstens 16 nullbare Felder: `WireSchema` hat nur Strings ("" = unbekannt), `fromWire` macht `null` daraus (Test in `test/extract.test.ts`).
- `airtrail/` – API-v1-Client und serialisierte Sync-Queue (`TripHooks`), Fehler am Segment (`airtrail_error`).
  Duplikatschutz: vor dem Anlegen `findExistingFlight` (Tag, Flughäfen, Passagier, Flugnummer) gegen die Flugliste
  (gilt nur, solange die Queue läuft); PUT immer über `mergeForUpdate` (AirTrail-Felder und fremde Passagiere bleiben).
- `auth/` – OIDC (openid-client v6), Sessions (signiertes Cookie, Hash in DB), Tokens (nur Hashes), Avatare.
- `oauth/routes.ts` – OAuth 2.1 für MCP (DCR, PKCE, rotierende Refresh-Tokens). Redirect-Regeln: jede https-URI, http nur Loopback (beliebiger Port).
- `ics.ts` – RFC 5545, UTC, Faltung. `time.ts` – lokale Zeit + IANA-Zone ↔ UTC (nur `Intl`).
- `db/migrations.ts` – Migrationen per `PRAGMA user_version`; nur anhängen, nie ändern.
- Anhänge ↔ Einträge: viele-zu-viele über `attachment_segments` (die Spalte `attachments.segment_id` ist seit Migration 2 ungenutzt).
  Beim Import liefert Claude pro Segment `documents` (PDF-Dateinamen); ohne Angabe hängt ein PDF an allen Segmenten der Buchung.
- Web: `App.svelte` (Routing über `app.path`), `components/*`, `lib/timeline.ts` (Hotel/Parkplatz/Mietwagen doppelt),
  `public/sw.js` (Netz zuerst, 4 s, nie `/auth /oauth /mcp /ics /healthz`), Icons aus `public/icon.svg` per `pnpm --filter @trips/web icons`.

## Verifikation

- `pnpm test` (vitest, gemockter fetch/Extraktion/Mailer, kein echter IMAP/API-Call), `pnpm typecheck`, `pnpm format:check`, `pnpm build`.
- Lokal starten: `SESSION_KEY=… DEV_LOGIN=true WEB_DIST=../web/dist pnpm --filter @trips/server dev` (Port 41873).
- tsup muss `removeNodeProtocol: false` behalten – sonst findet das Image `node:sqlite` nicht.
