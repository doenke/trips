import { z } from 'zod';
import type { Actor } from './errors.js';
import { badRequest } from './errors.js';
import { namesMatch } from './names.js';
import { segmentFields, tripFields } from './schemas.js';
import type { TripService } from './trips.js';
import { assertAdmin, type UserService } from './users.js';

/** The JSON format of GET /api/export – and what the admin import takes back. */
export const EXPORT_FORMAT = 'trips-export';

const ExportedSegment = z.object(segmentFields).extend({ source: z.string().optional() });
const ExportedTrip = z.object({
  title: tripFields.title,
  destination: tripFields.destination,
  start_date: tripFields.start_date,
  end_date: tripFields.end_date,
  notes: tripFields.notes,
  travelers: z.array(z.object({ name: z.string(), email: z.string().nullish() })).default([]),
  segments: z.array(ExportedSegment).default([]),
});
export const ExportFile = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.literal(1),
  exported_at: z.string().optional(),
  trips: z.array(ExportedTrip),
});
export type ExportFile = z.input<typeof ExportFile>;
export type ExportedTrip = z.output<typeof ExportedTrip>;

export interface ImportReport {
  created: { id: string; title: string; segments: number }[];
  skipped: string[];
  warnings: string[];
}

export class ExchangeService {
  constructor(
    private readonly trips: TripService,
    private readonly users: UserService,
  ) {}

  /** Every trip the user can read – that is: all of them. */
  export(actor: Actor): ExportFile {
    const list = this.trips.listTrips(actor, { filter: 'all' });
    return {
      format: EXPORT_FORMAT,
      version: 1,
      exported_at: new Date().toISOString(),
      trips: list.map((summary) => {
        const t = this.trips.getTrip(actor, summary.id);
        return {
          title: t.title,
          destination: t.destination,
          start_date: t.start_date,
          end_date: t.end_date,
          notes: t.notes,
          travelers: t.travelers.map((u) => ({ name: u.name, email: u.email })),
          segments: t.segments.map((s) => ({
            type: s.type,
            title: s.title,
            start_local: s.start_local,
            start_tz: s.start_tz,
            end_local: s.end_local,
            end_tz: s.end_tz,
            from_name: s.from_name,
            from_code: s.from_code,
            to_name: s.to_name,
            to_code: s.to_code,
            carrier: s.carrier,
            number: s.number,
            booking_ref: s.booking_ref,
            seat: s.seat,
            address: s.address,
            notes: s.notes,
            source: s.source,
          })),
        };
      }),
    };
  }

  /** Accounts for exported travelers: by email (login or alternative address), else by name. */
  resolveTravelers(travelers: { name: string; email?: string | null }[], warnings: string[]): string[] {
    const all = this.users.list();
    const ids: string[] = [];
    for (const t of travelers) {
      const u = (t.email && this.users.ownerOfEmail(t.email)) || all.find((x) => namesMatch(t.name, x.name));
      if (u) ids.push(u.id);
      else warnings.push(`Reisende(r) „${t.name}“ hat kein Konto – übersprungen.`);
    }
    return [...new Set(ids)];
  }

  /** Admin import. Trips with the same title and start date are skipped, so importing twice is harmless. */
  importTrips(actor: Actor, trips: ExportedTrip[]): ImportReport {
    assertAdmin(actor);
    const report: ImportReport = { created: [], skipped: [], warnings: [] };
    const existing = this.trips.listTrips(actor, { filter: 'all' });
    for (const t of trips) {
      if (existing.some((e) => e.title === t.title && e.start_date === t.start_date)) {
        report.skipped.push(`${t.title}${t.start_date ? ` (${t.start_date})` : ''}`);
        continue;
      }
      const travelers = this.resolveTravelers(t.travelers, report.warnings);
      const trip = this.trips.createTrip(actor, {
        title: t.title,
        destination: t.destination,
        start_date: t.start_date,
        end_date: t.end_date,
        notes: t.notes,
        traveler_ids: travelers.length ? travelers : [actor.userId],
      });
      let count = 0;
      for (const s of t.segments) {
        try {
          const { source: _source, ...input } = s;
          this.trips.addSegment(actor, trip.id, input, 'import');
          count++;
        } catch (err) {
          report.warnings.push(`${t.title}: Segment „${s.title ?? s.type}“ übersprungen (${(err as Error).message})`);
        }
      }
      report.created.push({ id: trip.id, title: trip.title, segments: count });
    }
    return report;
  }

  importFile(actor: Actor, data: unknown): ImportReport {
    const parsed = ExportFile.safeParse(data);
    if (!parsed.success) throw badRequest(`Unbekanntes Format: erwartet wird ein Export von Trips (format "${EXPORT_FORMAT}").`);
    return this.importTrips(actor, parsed.data.trips);
  }
}
