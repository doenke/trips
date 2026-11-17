import type { ExtractedSegment, Extraction, ExtractInput, Extractor } from '../extract/claude.js';
import { todayIn } from '../time.js';
import type { AttachmentService } from './attachments.js';
import { type Actor, AppError, forbidden } from './errors.js';
import { findSame } from './matching.js';
import { matchPassengers } from './names.js';
import { SegmentInput, type SegmentPatch, type Source } from './schemas.js';
import { TYPE_ICON, type TripService } from './trips.js';
import type { UserService } from './users.js';

export interface ImportResult {
  status: 'imported' | 'no_booking' | 'nothing_to_do';
  trip: { id: string; title: string; url: string } | null;
  trip_created: boolean;
  created: string[];
  updated: string[];
  deleted: string[];
  not_found: string[];
  travelers_added: string[];
  attachments: string[];
}

export interface BookingDocument {
  text: string;
  subject?: string | null;
  pdfs: { filename: string; data: Buffer }[];
}

function label(s: { type: ExtractedSegment['type']; title: string | null; start_local: string | null; number?: string | null }): string {
  const when = s.start_local ? ` (${formatLocal(s.start_local)})` : '';
  return `${TYPE_ICON[s.type]} ${s.title ?? s.number ?? ''}${when}`.replace(/\s+/g, ' ').trim();
}

function formatLocal(v: string): string {
  const [d, t] = v.split('T');
  const [y, m, day] = d!.split('-');
  return `${day}.${m}.${y}${t ? ` ${t}` : ''}`;
}

/** Only the values the booking actually states – an update never erases data with nulls. */
function patchFrom(input: SegmentInput): SegmentPatch {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== null && v !== undefined)) as SegmentPatch;
}

/**
 * Turns an extracted booking into trip changes. Used by the mail import, "Buchung einfügen" in the
 * app and the MCP tool import_booking_text – one path for all of them.
 */
export class BookingService {
  constructor(
    private readonly trips: TripService,
    private readonly users: UserService,
    private readonly attachments: AttachmentService,
    private readonly extractor: Extractor | null,
    private readonly opts: { publicUrl: string; timeZone?: string },
  ) {}

  get canExtract(): boolean {
    return !!this.extractor;
  }

  async extract(doc: BookingDocument): Promise<Extraction> {
    if (!this.extractor) throw new AppError(503, 'extraction_disabled', 'Die automatische Auswertung ist nicht eingerichtet (ANTHROPIC_API_KEY fehlt).');
    const input: ExtractInput = { ...doc, today: todayIn(this.opts.timeZone ?? 'Europe/Berlin') };
    return this.extractor(input);
  }

  async importDocument(actor: Actor, doc: BookingDocument, opts: { tripId?: string; source: Source }): Promise<ImportResult> {
    if (opts.tripId && !this.trips.canEdit(actor, opts.tripId)) throw forbidden();
    const extraction = await this.extract(doc);
    return this.apply(actor, extraction, { ...opts, pdfs: doc.pdfs });
  }

  apply(actor: Actor, e: Extraction, opts: { tripId?: string; source: Source; pdfs?: { filename: string; data: Buffer }[] }): ImportResult {
    const result: ImportResult = {
      status: 'imported',
      trip: null,
      trip_created: false,
      created: [],
      updated: [],
      deleted: [],
      not_found: [],
      travelers_added: [],
      attachments: [],
    };
    if (!e.is_booking || !e.segments.length) return { ...result, status: 'no_booking' };

    const matched = matchPassengers(e.passengers, this.users.list()).map((u) => u.id);
    const travelers = [actor.userId, ...matched.filter((id) => id !== actor.userId)];

    const normalized = e.segments.map((s) => {
      const { cancelled, ...fields } = s;
      const parsed = SegmentInput.safeParse(fields);
      return { raw: s, cancelled, input: parsed.success ? parsed.data : null };
    });
    const active = normalized.filter((s) => !s.cancelled && s.input);
    const cancelled = normalized.filter((s) => s.cancelled && s.input);

    // Which trip: given one, a matching one (±grace days, most shared travelers), or a new one.
    let tripId = opts.tripId ?? null;
    if (tripId && !this.trips.canEdit(actor, tripId)) throw forbidden();
    const dates = active.flatMap((s) => [s.input!.start_local, s.input!.end_local]).filter((d): d is string => !!d).map((d) => d.slice(0, 10)).sort();
    if (!tripId && dates.length) tripId = this.trips.findTripForDates(actor, dates[0]!, dates.at(-1)!, travelers)?.id ?? null;
    if (!tripId && active.length) {
      const first = active[0]!.input!;
      const trip = this.trips.createTrip(actor, {
        title: e.trip_title?.trim() || e.destination?.trim() || first.title || 'Neue Reise',
        destination: e.destination?.trim() || null,
        start_date: dates[0] ?? null,
        end_date: dates.at(-1) ?? null,
        notes: null,
        traveler_ids: travelers,
      });
      tripId = trip.id;
      result.trip_created = true;
    }

    const touched: string[] = [];
    if (tripId) {
      for (const s of active) {
        const existing = findSame(this.trips.segments(tripId), s.input!);
        if (existing) {
          const updated = this.trips.updateSegment(actor, existing.id, patchFrom(s.input!));
          result.updated.push(label(updated));
          touched.push(updated.id);
        } else {
          const created = this.trips.addSegment(actor, tripId, s.input!, opts.source);
          result.created.push(label(created));
          touched.push(created.id);
        }
      }
    }

    // Cancellations: in this trip, or else in any trip of the travelers that the sender may edit.
    for (const s of cancelled) {
      const candidates = tripId ? [tripId] : [];
      for (const t of this.trips.candidatesFor(travelers)) if (!candidates.includes(t.id) && this.trips.canEdit(actor, t.id)) candidates.push(t.id);
      let done = false;
      for (const id of candidates) {
        const hit = findSame(this.trips.segments(id), s.input!);
        if (hit) {
          this.trips.deleteSegment(actor, hit.id);
          result.deleted.push(label(hit));
          tripId ??= id;
          done = true;
          break;
        }
      }
      if (!done) result.not_found.push(label({ ...s.raw }));
    }

    if (!tripId) return { ...result, status: 'nothing_to_do' };

    if (!result.trip_created) {
      const added = this.trips.addTravelers(actor, tripId, matched);
      result.travelers_added = added.map((id) => this.users.get(id)?.name ?? id);
    } else {
      result.travelers_added = matched.filter((id) => id !== actor.userId).map((id) => this.users.get(id)?.name ?? id);
    }

    for (const pdf of opts.pdfs ?? []) {
      try {
        this.attachments.add(actor, tripId, { filename: pdf.filename, data: pdf.data, segmentId: touched.length === 1 ? touched[0] : null });
        result.attachments.push(pdf.filename);
      } catch {
        /* not a PDF after all, or too large – the booking itself is in */
      }
    }

    const trip = this.trips.getTrip(actor, tripId);
    result.trip = { id: trip.id, title: trip.title, url: `${this.opts.publicUrl}/trips/${trip.id}` };
    if (!result.created.length && !result.updated.length && !result.deleted.length) result.status = 'nothing_to_do';
    return result;
  }
}

/** Plain-text summary for mail and MCP: what happened, at a glance. */
export function summarize(r: ImportResult): string {
  if (r.status === 'no_booking') return 'In dieser Nachricht wurde keine Buchung erkannt. Es wurde nichts geändert.';
  const lines: string[] = [];
  if (r.trip) lines.push(`${r.trip_created ? 'Neue Reise angelegt' : 'Reise'}: ${r.trip.title}`);
  const block = (title: string, items: string[]) => {
    if (items.length) lines.push('', `${title}:`, ...items.map((i) => `  • ${i}`));
  };
  block('Neu', r.created);
  block('Aktualisiert', r.updated);
  block('Gelöscht (storniert)', r.deleted);
  block('Storno ohne passenden Eintrag', r.not_found);
  if (r.travelers_added.length) lines.push('', `Als Mitreisende eingetragen: ${r.travelers_added.join(', ')}`);
  if (r.attachments.length) lines.push('', `Angehängt: ${r.attachments.join(', ')}`);
  if (r.status === 'nothing_to_do' && !r.not_found.length) lines.push('', 'Alles war schon auf dem neuesten Stand.');
  if (r.trip) lines.push('', `Ansehen: ${r.trip.url}`);
  return lines.join('\n').trim();
}
