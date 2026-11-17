import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import type { Services } from '../app.js';
import { summarize } from '../service/booking.js';
import { type Actor, AppError } from '../service/errors.js';
import { segmentFields, tripFields } from '../service/schemas.js';
import { TYPE_ICON, type SegmentView, type TripSummary, type TripView } from '../service/trips.js';
import { addDays } from '../time.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

export function zodMessage(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || 'Eingabe'}: ${i.message}`).join('; ');
}

function when(local: string | null): string {
  if (!local) return '';
  const [d, t] = local.split('T');
  const [y, m, day] = d!.split('-');
  return `${day}.${m}.${y}${t ? ` ${t}` : ''}`;
}

function segmentLine(s: SegmentView): string {
  const parts = [
    `${TYPE_ICON[s.type]} ${s.title}`,
    s.start_local && `${when(s.start_local)}${s.start_tz ? ` (${s.start_tz})` : ''}`,
    s.end_local && `bis ${when(s.end_local)}`,
    s.booking_ref && `Buchung ${s.booking_ref}`,
    s.seat && `Platz/Zimmer ${s.seat}`,
  ].filter(Boolean);
  return `- ${parts.join(' · ')} [segment_id: ${s.id}]`;
}

function tripLine(t: TripSummary): string {
  const dates = t.start_date ? `${when(t.start_date)}–${when(t.end_date)}` : 'ohne Datum';
  const people = t.travelers.map((u) => u.name).join(', ');
  return `- ${t.title}${t.destination ? ` (${t.destination})` : ''}: ${dates}, ${t.segment_count} Einträge, Reisende: ${people}${t.can_edit ? '' : ' (nur lesen)'} [trip_id: ${t.id}]`;
}

function tripMarkdown(t: TripView): string {
  const lines = [
    `# ${t.title}`,
    `trip_id: ${t.id}`,
    t.destination && `Ziel: ${t.destination}`,
    t.start_date && `Zeitraum: ${when(t.start_date)} – ${when(t.end_date)}`,
    `Reisende: ${t.travelers.map((u) => `${u.name} [user_id: ${u.id}]`).join(', ')}`,
    `Darfst du ändern: ${t.can_edit ? 'ja' : 'nein (nur Reisende und Admins)'}`,
    t.notes && `Notizen: ${t.notes}`,
    '',
    '## Segmente',
    ...(t.segments.length ? t.segments.map(segmentLine) : ['(noch keine)']),
  ].filter((l): l is string => typeof l === 'string');
  if (t.attachments.length) lines.push('', '## Anhänge', ...t.attachments.map((a) => `- ${a.filename} (${a.mime}, ${Math.round(a.size / 1024)} KB) [attachment_id: ${a.id}]`));
  lines.push('', '## Details (JSON)', '```json', JSON.stringify(t.segments, null, 1), '```');
  return lines.join('\n');
}

const INSTRUCTIONS = `Trips verwaltet Reisen und Buchungen (Flüge, Züge, Hotels, Mietwagen, Parkplätze).
Eine Reise hat Reisende (Benutzer) und Segmente. Alle angemeldeten Benutzer dürfen alle Reisen lesen; ändern dürfen nur Reisende der Reise und Admins.
Zeiten sind immer lokale Zeiten am jeweiligen Ort (YYYY-MM-DDTHH:MM oder nur YYYY-MM-DD) plus IANA-Zeitzone (z. B. Europe/Berlin).
Hotels: Beginn = Check-in, Ende = Check-out. Parkplätze (type parking): Titel = Parkhaus/Anbieter, Beginn = Einfahrt, Ende = Ausfahrt, Stellplatz ins Feld seat, Kennzeichen/Shuttle/Zugang in notes.
Für einen Buchungstext (Bestätigungsmail usw.) am besten import_booking_text verwenden: das erkennt Segmente, Duplikate und Stornos und sortiert in die passende Reise ein.
Reisedaten erweitern sich automatisch, wenn Segmente außerhalb liegen. Flüge werden automatisch an AirTrail übertragen, wenn die Reisenden das eingerichtet haben.`;

/** One MCP server per request, bound to the token owner. Same services and checks as the REST API. */
export function createMcpServer(s: Services, actor: Actor, via: string): McpServer {
  const server = new McpServer({ name: 'trips', title: 'Trips – Reisen und Buchungen', version: s.config.APP_VERSION }, { instructions: INSTRUCTIONS });

  const guard =
    <A>(fn: (args: A) => Promise<ReturnType<typeof text>> | ReturnType<typeof text>) =>
    async (args: A) => {
      try {
        return await fn(args);
      } catch (err) {
        if (err instanceof AppError) return { ...text(err.message), isError: true };
        if (err instanceof ZodError) return { ...text(`Ungültige Eingabe: ${zodMessage(err)}`), isError: true };
        s.log.warn({ err, via }, 'MCP-Tool fehlgeschlagen');
        return { ...text(`Fehler: ${(err as Error).message}`), isError: true };
      }
    };

  const read = { readOnlyHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

  server.registerTool(
    'list_trips',
    {
      title: 'Reisen auflisten',
      description: 'Listet Reisen mit Zeitraum, Reisenden und trip_id. Standard: kommende Reisen aller Benutzer.',
      inputSchema: {
        filter: z.enum(['upcoming', 'past', 'all']).default('upcoming').describe('upcoming = noch nicht vorbei, past = vorbei, all = alle'),
        mine: z.boolean().default(false).describe('true = nur Reisen, auf denen du selbst reist'),
      },
      annotations: read,
    },
    guard(({ filter, mine }: { filter: 'upcoming' | 'past' | 'all'; mine: boolean }) => {
      const list = s.trips.listTrips(actor, { filter, mine });
      return text(list.length ? list.map(tripLine).join('\n') : 'Keine Reisen gefunden.');
    }),
  );

  server.registerTool(
    'get_trip',
    {
      title: 'Reise anzeigen',
      description: 'Eine Reise mit allen Segmenten (inkl. segment_id und allen Feldern), Reisenden und Anhängen.',
      inputSchema: { trip_id: z.string() },
      annotations: read,
    },
    guard(({ trip_id }: { trip_id: string }) => text(tripMarkdown(s.trips.getTrip(actor, trip_id)))),
  );

  server.registerTool(
    'create_trip',
    {
      title: 'Reise anlegen',
      description: 'Legt eine neue Reise an. Ohne traveler_ids bist du der einzige Reisende. Segmente danach mit add_segment oder import_booking_text hinzufügen.',
      inputSchema: tripFields,
      annotations: write,
    },
    guard((args: unknown) => {
      const t = s.trips.createTrip(actor, z.object(tripFields).parse(args));
      return text(`Reise angelegt: ${t.title} [trip_id: ${t.id}]`);
    }),
  );

  server.registerTool(
    'update_trip',
    {
      title: 'Reise ändern',
      description: 'Ändert Titel, Ziel, Datum, Notizen oder Reisende einer Reise. Nur angegebene Felder ändern sich; traveler_ids ersetzt die komplette Liste der Reisenden.',
      inputSchema: { trip_id: z.string(), ...z.object(tripFields).partial().shape },
      annotations: write,
    },
    guard((args: { trip_id: string } & Record<string, unknown>) => {
      const { trip_id, ...patch } = args;
      const t = s.trips.updateTrip(actor, trip_id, z.object(tripFields).partial().parse(patch));
      return text(`Reise aktualisiert: ${t.title} (${t.travelers.map((u) => u.name).join(', ')})`);
    }),
  );

  server.registerTool(
    'delete_trip',
    {
      title: 'Reise löschen',
      description: 'Löscht eine Reise mit allen Segmenten und Anhängen endgültig. Vorher beim Benutzer nachfragen.',
      inputSchema: { trip_id: z.string() },
      annotations: destructive,
    },
    guard(({ trip_id }: { trip_id: string }) => {
      const t = s.trips.getTrip(actor, trip_id);
      const { attachmentIds } = s.trips.deleteTrip(actor, trip_id);
      s.attachments.removeFiles(attachmentIds);
      return text(`Reise „${t.title}“ gelöscht.`);
    }),
  );

  server.registerTool(
    'add_segment',
    {
      title: 'Segment hinzufügen',
      description:
        'Fügt einer Reise ein Segment hinzu: flight, train, hotel, car, parking oder other. Zeiten als lokale Zeit am Ort plus IANA-Zeitzone. Flüge mit IATA-Codes in from_code/to_code und number wie "LH 2010".',
      inputSchema: { trip_id: z.string(), ...segmentFields },
      annotations: write,
    },
    guard((args: { trip_id: string } & Record<string, unknown>) => {
      const { trip_id, ...input } = args;
      const seg = s.trips.addSegment(actor, trip_id, z.object(segmentFields).parse(input), 'mcp');
      return text(`Hinzugefügt: ${segmentLine(seg)}`);
    }),
  );

  server.registerTool(
    'update_segment',
    {
      title: 'Segment ändern',
      description: 'Ändert ein Segment. Nur angegebene Felder ändern sich; null löscht einen Wert.',
      inputSchema: { segment_id: z.string(), ...z.object(segmentFields).partial().shape },
      annotations: write,
    },
    guard((args: { segment_id: string } & Record<string, unknown>) => {
      const { segment_id, ...patch } = args;
      const seg = s.trips.updateSegment(actor, segment_id, z.object(segmentFields).partial().parse(patch));
      return text(`Aktualisiert: ${segmentLine(seg)}`);
    }),
  );

  server.registerTool(
    'delete_segment',
    {
      title: 'Segment löschen',
      description: 'Löscht ein Segment (z. B. nach einer Stornierung).',
      inputSchema: { segment_id: z.string() },
      annotations: destructive,
    },
    guard(({ segment_id }: { segment_id: string }) => {
      const seg = s.trips.getSegment(segment_id);
      s.trips.deleteSegment(actor, segment_id);
      return text(`Gelöscht: ${seg.title}`);
    }),
  );

  server.registerTool(
    'find_trip_for_date',
    {
      title: 'Passende Reise finden',
      description: `Findet die Reise, zu der ein Zeitraum gehört – mit derselben Regel wie der Mail-Import: Überschneidung mit ±${s.config.TRIP_MATCH_DAYS} Tagen Karenz, bevorzugt die Reise mit den meisten gemeinsamen Reisenden, dann die nächstgelegene. Nur Reisen, die du ändern darfst.`,
      inputSchema: {
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD'),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD, Standard = start_date'),
        traveler_ids: z.array(z.string()).optional().describe('Reisende, Standard = du'),
      },
      annotations: read,
    },
    guard(({ start_date, end_date, traveler_ids }: { start_date: string; end_date?: string; traveler_ids?: string[] }) => {
      const t = s.trips.findTripForDates(actor, start_date, end_date ?? start_date, traveler_ids?.length ? traveler_ids : [actor.userId]);
      return text(t ? `Passende Reise: ${t.title} (${when(t.start_date)}–${when(t.end_date)}) [trip_id: ${t.id}]` : 'Keine passende Reise gefunden – lege mit create_trip eine neue an.');
    }),
  );

  server.registerTool(
    'import_booking_text',
    {
      title: 'Buchungstext übernehmen',
      description:
        'Übernimmt den Text einer Buchung (Bestätigungsmail, Reiseplan, Storno) wie der Mail-Import: Segmente erkennen, passende Reise finden oder anlegen, Duplikate aktualisieren, Stornos löschen, Mitreisende ergänzen. Gibt eine Zusammenfassung zurück.',
      inputSchema: {
        text: z.string().min(20).max(200_000).describe('Der vollständige Buchungstext'),
        trip_id: z.string().optional().describe('Optional: Segmente direkt in diese Reise übernehmen'),
      },
      annotations: { ...write, openWorldHint: true },
    },
    guard(async ({ text: body, trip_id }: { text: string; trip_id?: string }) => {
      const r = await s.booking.importDocument(actor, { text: body, pdfs: [] }, { tripId: trip_id, source: 'mcp' });
      return text(`${summarize(r)}${r.trip ? `\n[trip_id: ${r.trip.id}]` : ''}`);
    }),
  );

  server.registerTool(
    'list_users',
    {
      title: 'Benutzer auflisten',
      description: 'Alle Benutzer mit Namen und user_id – zum Setzen von Reisenden (traveler_ids).',
      inputSchema: {},
      annotations: read,
    },
    guard(() => text(s.users.list().map((u) => `- ${u.name}${u.id === actor.userId ? ' (du)' : ''} [user_id: ${u.id}]`).join('\n'))),
  );

  server.registerTool(
    'get_attachment_info',
    {
      title: 'Anhang-Info',
      description: 'Metadaten eines Anhangs (PDF/Bild) und die Download-Adresse. Die Datei selbst wird nicht übertragen.',
      inputSchema: { attachment_id: z.string() },
      annotations: read,
    },
    guard(({ attachment_id }: { attachment_id: string }) => {
      const a = s.attachments.get(attachment_id);
      return text(
        JSON.stringify(
          { id: a.id, trip_id: a.trip_id, segment_id: a.segment_id, filename: a.filename, mime: a.mime, size: a.size, created_at: a.created_at, download_url: `${s.config.PUBLIC_URL}/api/attachments/${a.id}` },
          null,
          1,
        ),
      );
    }),
  );

  server.registerResource(
    'upcoming',
    'trips://upcoming',
    { title: 'Nächste Reisen', description: 'Kompakte Übersicht der kommenden Reisen', mimeType: 'text/markdown' },
    async (uri) => {
      const list = s.trips.listTrips(actor, { filter: 'upcoming' }).filter((t) => !t.start_date || t.start_date <= addDays(new Date().toISOString().slice(0, 10), 365));
      const body = list.length
        ? list.map((t) => `${tripLine(t)}${t.next_segment ? `\n  nächstes: ${segmentLine(t.next_segment).slice(2)}` : ''}`).join('\n')
        : 'Keine kommenden Reisen.';
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: `# Kommende Reisen\n\n${body}` }] };
    },
  );

  return server;
}

/** MCP over Streamable HTTP at /mcp (stateless: a fresh server per request). */
export async function mcpRoutes(app: FastifyInstance, opts: { services: Services; requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<void> }): Promise<void> {
  app.post('/mcp', { preHandler: opts.requireUser }, async (request, reply) => {
    const p = request.principal!;
    const server = createMcpServer(opts.services, p.actor, p.tokenName ?? 'Sitzung');
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  const notAllowed = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header('Allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}

