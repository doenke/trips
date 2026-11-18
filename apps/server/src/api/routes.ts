import { createReadStream } from 'node:fs';
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Services } from '../app.js';
import { documentFromFiles } from '../mail/documents.js';
import { type BookingDocument, summarize } from '../service/booking.js';
import { AppError, badRequest } from '../service/errors.js';
import { SegmentInput, SegmentPatch, TripInput, TripPatch } from '../service/schemas.js';
import { assertAdmin, publicUser } from '../service/users.js';
import { tripitToExport } from '../service/tripit.js';

const Id = z.object({ id: z.string().min(1).max(100) });

/** Reads a multipart request: text fields and file buffers. */
async function readMultipart(request: FastifyRequest): Promise<{ fields: Record<string, string>; files: { filename: string; data: Buffer }[] }> {
  const fields: Record<string, string> = {};
  const files: { filename: string; data: Buffer }[] = [];
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      const f = part as MultipartFile;
      const data = await f.toBuffer();
      if (data.length) files.push({ filename: f.filename || 'Datei', data });
    } else {
      fields[part.fieldname] = String(part.value ?? '');
    }
  }
  return { fields, files };
}

export async function apiRoutes(
  app: FastifyInstance,
  opts: { services: Services; requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<void> },
): Promise<void> {
  const s = opts.services;
  const { config } = s;
  const actorOf = (request: FastifyRequest) => request.principal!.actor;

  /** Token and connection management only from the app itself, never with a token. */
  const sessionOnly = (request: FastifyRequest) => {
    if (request.principal!.via !== 'session') throw new AppError(403, 'session_required', 'Das geht nur in der App selbst.');
  };

  app.register(async (api) => {
    api.addHook('preHandler', opts.requireUser);
    api.addHook('onSend', async (_req, reply) => {
      if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    });

    // ---- me & settings ------------------------------------------------------------------

    api.get('/api/me', async (request) => {
      const u = s.users.require(request.principal!.userId);
      return {
        user: publicUser(u),
        via: request.principal!.via,
        alt_emails: s.users.altEmails(u.id),
        airtrail: { enabled: s.airtrail.enabled, url: config.AIRTRAIL_URL ?? null, connected: !!u.airtrail_key, status: u.airtrail_status },
        ics_url: `${config.PUBLIC_URL}/ics/${s.users.icsToken(u.id)}.ics`,
        import_address: config.IMPORT_ADDRESS ?? null,
        mcp_url: `${config.PUBLIC_URL}/mcp`,
        extraction: s.booking.canExtract,
        version: config.APP_VERSION,
        provider: config.OIDC_PROVIDER_NAME,
      };
    });

    api.get('/api/users', async () => s.users.list().map(publicUser));

    api.post('/api/me/emails', async (request) => {
      const { email } = z.object({ email: z.string().max(200) }).parse(request.body);
      return { alt_emails: s.users.addAltEmail(request.principal!.userId, email) };
    });
    api.delete('/api/me/emails/:email', async (request) => {
      const { email } = z.object({ email: z.string() }).parse(request.params);
      return { alt_emails: s.users.removeAltEmail(request.principal!.userId, email) };
    });

    api.post('/api/me/ics/rotate', async (request) => {
      sessionOnly(request);
      return { ics_url: `${config.PUBLIC_URL}/ics/${s.users.rotateIcsToken(request.principal!.userId)}.ics` };
    });

    api.put('/api/me/airtrail', async (request) => {
      sessionOnly(request);
      const { key } = z.object({ key: z.string().trim().min(4, 'API-Key fehlt').max(500) }).parse(request.body);
      const client = s.airtrail.client;
      if (!client) throw new AppError(503, 'airtrail_disabled', 'AirTrail ist nicht eingerichtet (AIRTRAIL_URL fehlt).');
      let me: { id: string; name: string };
      try {
        me = await client.me(key);
      } catch (err) {
        throw badRequest(`AirTrail hat den Key nicht akzeptiert: ${(err as Error).message}`);
      }
      const userId = request.principal!.userId;
      s.users.setAirtrail(userId, key, me.id, `verbunden als ${me.name || me.id}`);
      s.airtrail.userKeyChanged(userId);
      return { connected: true, status: `verbunden als ${me.name || me.id}` };
    });
    api.post('/api/me/airtrail/check', async (request) => {
      const userId = request.principal!.userId;
      const key = s.users.airtrailKey(userId);
      const client = s.airtrail.client;
      if (!key || !client) return { connected: false, status: null };
      try {
        const me = await client.me(key);
        const status = `verbunden als ${me.name || me.id}`;
        s.users.setAirtrailStatus(userId, status);
        return { connected: true, status };
      } catch (err) {
        const status = `Fehler: ${(err as Error).message}`;
        s.users.setAirtrailStatus(userId, status);
        return { connected: true, status };
      }
    });
    api.delete('/api/me/airtrail', async (request) => {
      sessionOnly(request);
      s.users.setAirtrail(request.principal!.userId, null, null, null);
      return { connected: false };
    });

    api.get('/api/tokens', async (request) => {
      sessionOnly(request);
      return s.tokens.list(request.principal!.userId);
    });
    api.post('/api/tokens', async (request) => {
      sessionOnly(request);
      const { name } = z.object({ name: z.string().trim().min(1, 'Name fehlt').max(60) }).parse(request.body);
      // The token itself is shown exactly once.
      return s.tokens.createPersonal(request.principal!.userId, name);
    });
    api.delete('/api/tokens/:id', async (request) => {
      sessionOnly(request);
      s.tokens.revoke(request.principal!.userId, Id.parse(request.params).id);
      return { ok: true };
    });

    // ---- trips ----------------------------------------------------------------------------

    api.get('/api/trips', async (request) => {
      const q = z
        .object({
          filter: z.enum(['upcoming', 'past', 'all']).default('all'),
          mine: z.enum(['true', 'false', '1', '0']).optional(),
          q: z.string().max(200).optional(),
        })
        .parse(request.query);
      return s.trips.listTrips(actorOf(request), { filter: q.filter, mine: q.mine === 'true' || q.mine === '1', query: q.q });
    });

    api.get('/api/trips/find', async (request) => {
      const q = z
        .object({
          start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          end: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
        })
        .parse(request.query);
      return { trip: s.trips.findTripForDates(actorOf(request), q.start, q.end ?? q.start) };
    });

    api.post('/api/trips', async (request, reply) => reply.code(201).send(s.trips.createTrip(actorOf(request), TripInput.parse(request.body))));
    api.get('/api/trips/:id', async (request) => s.trips.getTrip(actorOf(request), Id.parse(request.params).id));
    api.patch('/api/trips/:id', async (request) => s.trips.updateTrip(actorOf(request), Id.parse(request.params).id, TripPatch.parse(request.body)));
    api.delete('/api/trips/:id', async (request) => {
      const { attachmentIds } = s.trips.deleteTrip(actorOf(request), Id.parse(request.params).id);
      s.attachments.removeFiles(attachmentIds);
      return { ok: true };
    });

    api.post('/api/trips/:id/segments', async (request, reply) =>
      reply.code(201).send(s.trips.addSegment(actorOf(request), Id.parse(request.params).id, SegmentInput.parse(request.body), 'manual')),
    );
    api.patch('/api/segments/:id', async (request) => s.trips.updateSegment(actorOf(request), Id.parse(request.params).id, SegmentPatch.parse(request.body)));
    api.post('/api/segments/:id/move', async (request) => {
      const body = z
        .object({ trip_id: z.string().optional(), new_trip_title: z.string().trim().max(200).optional() })
        .refine((b) => !!b.trip_id !== !!b.new_trip_title, 'Entweder trip_id oder new_trip_title angeben')
        .parse(request.body);
      return s.trips.moveSegment(actorOf(request), Id.parse(request.params).id, { tripId: body.trip_id, newTripTitle: body.new_trip_title });
    });
    api.delete('/api/segments/:id', async (request) => {
      s.trips.deleteSegment(actorOf(request), Id.parse(request.params).id);
      return { ok: true };
    });

    // ---- booking import ("Buchung einfügen") --------------------------------------------------

    const importHandler = async (request: FastifyRequest, tripId?: string) => {
      const actor = actorOf(request);
      if (tripId && !s.trips.canEdit(actor, tripId)) s.trips.getTrip(actor, tripId); // 404 before 403
      let doc: BookingDocument;
      if (request.isMultipart()) {
        // Text, PDFs and mails (.eml, Outlook .msg) – e.g. dragged from the mail program into the app.
        const m = await readMultipart(request);
        doc = await documentFromFiles(m.files, m.fields.text ?? '');
      } else {
        doc = { text: z.object({ text: z.string().max(200_000) }).parse(request.body).text, pdfs: [] };
      }
      if (doc.text.trim().length < 20 && !doc.pdfs.length) throw badRequest('Bitte den Buchungstext einfügen oder eine E-Mail bzw. ein PDF auswählen.');
      const result = await s.booking.importDocument(actor, doc, { tripId, source: 'manual' });
      return { ...result, summary: summarize(result) };
    };
    api.post('/api/trips/:id/import', async (request) => importHandler(request, Id.parse(request.params).id));
    api.post('/api/import', async (request) => importHandler(request));

    // ---- attachments -----------------------------------------------------------------------

    api.post('/api/trips/:id/attachments', async (request, reply) => {
      const tripId = Id.parse(request.params).id;
      const m = await readMultipart(request);
      if (!m.files.length) throw badRequest('Keine Datei ausgewählt.');
      const rows = m.files.map((f) =>
        s.attachments.add(actorOf(request), tripId, { filename: f.filename, data: f.data, segmentId: m.fields.segment_id || null }),
      );
      return reply
        .code(201)
        .send(rows.map((a) => ({ id: a.id, filename: a.filename, mime: a.mime, size: a.size, segment_id: a.segment_id, url: `/api/attachments/${a.id}` })));
    });

    api.get('/api/attachments/:id', async (request, reply) => {
      const a = s.attachments.get(Id.parse(request.params).id);
      const download = (request.query as Record<string, string>).download === '1';
      const name = encodeURIComponent(a.filename);
      return reply
        .type(a.mime)
        .header('Cache-Control', 'private, max-age=86400')
        .header('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${name}`)
        .header(
          'Content-Security-Policy',
          "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; object-src 'self'; plugin-types application/pdf",
        )
        .send(createReadStream(s.attachments.path(a.id)));
    });

    api.delete('/api/attachments/:id', async (request) => {
      s.attachments.delete(actorOf(request), Id.parse(request.params).id);
      return { ok: true };
    });

    // ---- export / admin --------------------------------------------------------------------

    api.get('/api/export', async (request, reply) =>
      reply
        .header('Content-Disposition', `attachment; filename="trips-export-${new Date().toISOString().slice(0, 10)}.json"`)
        .send(s.exchange.export(actorOf(request))),
    );

    api.get('/api/admin/mail-log', async (request) => {
      assertAdmin(actorOf(request));
      return s.mail.recent(200);
    });

    api.post('/api/admin/import', async (request) => {
      const actor = actorOf(request);
      assertAdmin(actor);
      let data: unknown = request.body;
      if (request.isMultipart()) {
        const m = await readMultipart(request);
        if (!m.files[0]) throw badRequest('Keine Datei ausgewählt.');
        try {
          data = JSON.parse(m.files[0].data.toString('utf8'));
        } catch {
          throw badRequest('Die Datei ist kein gültiges JSON.');
        }
      }
      const tripit = tripitToExport(data);
      return tripit ? s.exchange.importTrips(actor, tripit) : s.exchange.importFile(actor, data);
    });
  });
}
