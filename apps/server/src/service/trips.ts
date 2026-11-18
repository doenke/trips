import { randomUUID } from 'node:crypto';
import { airportZone } from '../airports.js';
import type { Db } from '../db/index.js';
import { localToUtc, todayIn } from '../time.js';
import { type Actor, badRequest, forbidden, notFound } from './errors.js';
import { pickTrip, returnDay, type TripCandidate } from './matching.js';
import { type SegmentInput, type SegmentPatch, type SegmentType, type Source, type TripInput, type TripPatch } from './schemas.js';
import { type PublicUser, publicUser, type UserRow } from './users.js';

export interface TripRow {
  id: string;
  title: string;
  destination: string | null;
  start_date: string | null;
  end_date: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SegmentRow {
  id: string;
  trip_id: string;
  type: SegmentType;
  title: string;
  start_local: string | null;
  start_tz: string | null;
  end_local: string | null;
  end_tz: string | null;
  from_name: string | null;
  from_code: string | null;
  to_name: string | null;
  to_code: string | null;
  carrier: string | null;
  number: string | null;
  booking_ref: string | null;
  seat: string | null;
  address: string | null;
  notes: string | null;
  source: Source;
  airtrail_ids: string;
  airtrail_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface AttachmentRow {
  id: string;
  trip_id: string;
  /** Unused since migration 2 (see attachment_segments). */
  segment_id: string | null;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  created_by: string | null;
  created_at: string;
}

export interface SegmentView extends Omit<SegmentRow, 'airtrail_ids'> {
  start_utc: string | null;
  end_utc: string | null;
  airtrail: { users: string[]; error: string | null };
}

export interface AttachmentView {
  id: string;
  /** The segments the file belongs to; empty = the whole trip. */
  segment_ids: string[];
  filename: string;
  mime: string;
  size: number;
  url: string;
  created_at: string;
}

export interface TripView extends TripRow {
  travelers: PublicUser[];
  can_edit: boolean;
  segments: SegmentView[];
  attachments: AttachmentView[];
}

export interface TripSummary extends TripRow {
  travelers: PublicUser[];
  can_edit: boolean;
  segment_count: number;
  next_segment: SegmentView | null;
}

/** Side effects of trip changes (AirTrail sync). Called after the transaction committed. */
export interface TripHooks {
  segmentChanged(segmentId: string): void;
  segmentRemoved(segment: Pick<SegmentRow, 'id' | 'airtrail_ids'>): void;
  travelersChanged(tripId: string): void;
}

const noHooks: TripHooks = { segmentChanged() {}, segmentRemoved() {}, travelersChanged() {} };

/** Lowercase, umlauts written out and stripped alike ("Düsseldorf" finds "Dusseldorf" and "Duesseldorf"). */
function searchText(v: string): string {
  const lower = v.toLowerCase();
  const spelled = lower.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
  const stripped = lower.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return `${spelled} ${stripped}`;
}

function searchWords(q: string): string[] {
  return q
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/\s+/)
    .filter(Boolean);
}

export const TYPE_LABEL: Record<SegmentType, string> = {
  flight: 'Flug',
  train: 'Zug',
  hotel: 'Hotel',
  car: 'Mietwagen',
  parking: 'Parkplatz',
  other: 'Termin',
};

export const TYPE_ICON: Record<SegmentType, string> = { flight: '✈️', train: '🚆', hotel: '🏨', car: '🚗', parking: '🅿️', other: '📌' };

/** "LH 2010 DUS → MUC", "Holiday Parking DUS P7", … */
export function autoTitle(s: Pick<SegmentInput, 'type' | 'title' | 'number' | 'carrier' | 'from_code' | 'from_name' | 'to_code' | 'to_name'>): string {
  if (s.title) return s.title;
  const from = s.from_code ?? s.from_name;
  const to = s.to_code ?? s.to_name;
  const route = from && to ? `${from} → ${to}` : (from ?? to ?? '');
  if (s.type === 'flight' || s.type === 'train') return [s.number ?? TYPE_LABEL[s.type], route].filter(Boolean).join(' ');
  return s.carrier ?? TYPE_LABEL[s.type];
}

function utcOf(local: string | null, tz: string | null): string | null {
  if (!local) return null;
  try {
    return localToUtc(local, tz).toISOString();
  } catch {
    return null;
  }
}

export function segmentView(s: SegmentRow): SegmentView {
  const { airtrail_ids, ...rest } = s;
  let ids: Record<string, string> = {};
  try {
    ids = JSON.parse(airtrail_ids) as Record<string, string>;
  } catch {
    /* empty */
  }
  return {
    ...rest,
    start_utc: utcOf(s.start_local, s.start_tz),
    end_utc: utcOf(s.end_local, s.end_tz),
    airtrail: { users: Object.keys(ids), error: s.airtrail_error },
  };
}

function sortSegments(list: SegmentView[]): SegmentView[] {
  return list.sort((a, b) => (a.start_utc ?? a.end_utc ?? '9999').localeCompare(b.start_utc ?? b.end_utc ?? '9999'));
}

const SEGMENT_COLUMNS = [
  'type',
  'title',
  'start_local',
  'start_tz',
  'end_local',
  'end_tz',
  'from_name',
  'from_code',
  'to_name',
  'to_code',
  'carrier',
  'number',
  'booking_ref',
  'seat',
  'address',
  'notes',
] as const;

export class TripService {
  hooks: TripHooks = noHooks;

  constructor(
    private readonly db: Db,
    private readonly opts: { graceDays: number; timeZone?: string } = { graceDays: 5 },
  ) {}

  // ---- permissions ----------------------------------------------------------------

  travelerIds(tripId: string): string[] {
    return this.db.all<{ user_id: string }>('SELECT user_id FROM trip_travelers WHERE trip_id = ?', tripId).map((r) => r.user_id);
  }

  canEdit(actor: Actor, tripId: string): boolean {
    return actor.isAdmin || this.travelerIds(tripId).includes(actor.userId);
  }

  /** Every signed-in user may read every trip; changing needs a traveler or an admin. */
  private requireTrip(tripId: string): TripRow {
    const t = this.db.get<TripRow>('SELECT * FROM trips WHERE id = ?', tripId);
    if (!t) throw notFound('Reise');
    return t;
  }

  private requireEditable(actor: Actor, tripId: string): TripRow {
    const t = this.requireTrip(tripId);
    if (!this.canEdit(actor, tripId)) throw forbidden();
    return t;
  }

  private requireSegment(segmentId: string): SegmentRow {
    const s = this.db.get<SegmentRow>('SELECT * FROM segments WHERE id = ?', segmentId);
    if (!s) throw notFound('Segment');
    return s;
  }

  // ---- reading ----------------------------------------------------------------------

  private travelers(tripId: string): PublicUser[] {
    return this.db
      .all<UserRow>('SELECT u.* FROM trip_travelers t JOIN users u ON u.id = t.user_id WHERE t.trip_id = ? ORDER BY u.name COLLATE NOCASE', tripId)
      .map(publicUser);
  }

  segments(tripId: string): SegmentView[] {
    return sortSegments(this.db.all<SegmentRow>('SELECT * FROM segments WHERE trip_id = ?', tripId).map(segmentView));
  }

  attachments(tripId: string): AttachmentView[] {
    const links = new Map<string, string[]>();
    for (const l of this.db.all<{ attachment_id: string; segment_id: string }>(
      'SELECT l.attachment_id, l.segment_id FROM attachment_segments l JOIN attachments a ON a.id = l.attachment_id WHERE a.trip_id = ?',
      tripId,
    ))
      links.set(l.attachment_id, [...(links.get(l.attachment_id) ?? []), l.segment_id]);
    return this.db.all<AttachmentRow>('SELECT * FROM attachments WHERE trip_id = ? ORDER BY created_at', tripId).map((a) => ({
      id: a.id,
      segment_ids: links.get(a.id) ?? [],
      filename: a.filename,
      mime: a.mime,
      size: a.size,
      url: `/api/attachments/${a.id}`,
      created_at: a.created_at,
    }));
  }

  getTrip(actor: Actor, tripId: string): TripView {
    const t = this.requireTrip(tripId);
    return {
      ...t,
      travelers: this.travelers(tripId),
      can_edit: this.canEdit(actor, tripId),
      segments: this.segments(tripId),
      attachments: this.attachments(tripId),
    };
  }

  /**
   * upcoming = not over yet (end today or later), past = over. Sorted by start; past ones newest first.
   * query searches title, destination, notes and every segment (titles, numbers, places, airport codes,
   * booking numbers); all words must match, case and umlauts don't matter. Results: newest first.
   */
  listTrips(actor: Actor, opts: { filter?: 'upcoming' | 'past' | 'all'; mine?: boolean; now?: Date; query?: string } = {}): TripSummary[] {
    const filter = opts.filter ?? 'all';
    const today = todayIn(this.opts.timeZone ?? 'Europe/Berlin', opts.now);
    const rows = opts.mine
      ? this.db.all<TripRow>('SELECT t.* FROM trips t JOIN trip_travelers x ON x.trip_id = t.id WHERE x.user_id = ?', actor.userId)
      : this.db.all<TripRow>('SELECT * FROM trips');
    const nowIso = (opts.now ?? new Date()).toISOString();
    const words = searchWords(opts.query ?? '');
    const result = rows
      .filter((t) => {
        if (filter === 'all') return true;
        const end = t.end_date ?? t.start_date;
        const upcoming = !end || end >= today;
        return filter === 'upcoming' ? upcoming : !upcoming;
      })
      .filter((t) => !words.length || this.matches(t, words))
      .map((t) => {
        const segs = this.segments(t.id);
        const next = segs.find((s) => (s.end_utc ?? s.start_utc ?? '') >= nowIso) ?? null;
        return { ...t, travelers: this.travelers(t.id), can_edit: this.canEdit(actor, t.id), segment_count: segs.length, next_segment: next };
      });
    result.sort((a, b) => (a.start_date ?? '9999').localeCompare(b.start_date ?? '9999'));
    if (filter === 'past' || words.length) result.reverse();
    return result;
  }

  private matches(t: TripRow, words: string[]): boolean {
    const segs = this.db.all<SegmentRow>('SELECT * FROM segments WHERE trip_id = ?', t.id);
    const haystack = searchText(
      [
        t.title,
        t.destination,
        t.notes,
        ...segs.flatMap((s) => [s.title, s.number, s.carrier, s.from_name, s.from_code, s.to_name, s.to_code, s.booking_ref, s.address, s.notes]),
      ]
        .filter(Boolean)
        .join(' '),
    );
    // Numbers like "LH2010" also match "LH 2010".
    const compact = haystack.replace(/\s+/g, '');
    return words.every((w) => haystack.includes(w) || compact.includes(w.replace(/\s+/g, '')));
  }

  /** Trips (with dates) on which any of the given users travels – candidates for matching. */
  candidatesFor(userIds: string[]): TripCandidate[] {
    if (!userIds.length) return [];
    const rows = this.db.all<TripRow>(
      `SELECT DISTINCT t.* FROM trips t JOIN trip_travelers x ON x.trip_id = t.id WHERE x.user_id IN (${userIds.map(() => '?').join(',')})`,
      ...userIds,
    );
    return rows.map((t) => ({
      ...t,
      travelerIds: this.travelerIds(t.id),
      returnDay: returnDay(this.db.all<SegmentRow>('SELECT * FROM segments WHERE trip_id = ?', t.id)),
    }));
  }

  /** The trip a date range belongs to (same rule as the mail import), limited to trips the actor may edit. */
  findTripForDates(actor: Actor, start: string, end: string, travelerIds: string[] = [actor.userId]): TripRow | null {
    const candidates = this.candidatesFor(travelerIds).filter((t) => this.canEdit(actor, t.id));
    const hit = pickTrip(candidates, start, end, travelerIds, this.opts.graceDays);
    return hit ? this.requireTrip(hit.id) : null;
  }

  // ---- trips ------------------------------------------------------------------------

  private checkTravelers(ids: string[]): string[] {
    const unique = [...new Set(ids)];
    for (const id of unique) if (!this.db.get('SELECT 1 FROM users WHERE id = ?', id)) throw badRequest(`Unbekannter Reisender: ${id}`);
    return unique;
  }

  private checkDates(start: string | null, end: string | null): void {
    if (start && end && end < start) throw badRequest('Das Enddatum liegt vor dem Startdatum.');
  }

  createTrip(actor: Actor, input: TripInput): TripView {
    let travelers = this.checkTravelers(input.traveler_ids?.length ? input.traveler_ids : [actor.userId]);
    // Without admin rights you can't create a trip you can't edit afterwards.
    if (!actor.isAdmin && !travelers.includes(actor.userId)) travelers = [actor.userId, ...travelers];
    this.checkDates(input.start_date, input.end_date);
    const id = randomUUID();
    this.db.tx(() => {
      this.db.run(
        'INSERT INTO trips (id, title, destination, start_date, end_date, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        input.title,
        input.destination,
        input.start_date ?? input.end_date,
        input.end_date ?? input.start_date,
        input.notes,
        actor.userId,
      );
      for (const u of travelers) this.db.run('INSERT INTO trip_travelers (trip_id, user_id) VALUES (?, ?)', id, u);
    });
    return this.getTrip(actor, id);
  }

  updateTrip(actor: Actor, tripId: string, patch: TripPatch): TripView {
    const t = this.requireEditable(actor, tripId);
    const next = {
      title: patch.title ?? t.title,
      destination: patch.destination !== undefined ? patch.destination : t.destination,
      start_date: patch.start_date !== undefined ? patch.start_date : t.start_date,
      end_date: patch.end_date !== undefined ? patch.end_date : t.end_date,
      notes: patch.notes !== undefined ? patch.notes : t.notes,
    };
    this.checkDates(next.start_date, next.end_date);
    let travelersChanged = false;
    this.db.tx(() => {
      this.db.run(
        `UPDATE trips SET title = ?, destination = ?, start_date = ?, end_date = ?, notes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        next.title,
        next.destination,
        next.start_date,
        next.end_date,
        next.notes,
        tripId,
      );
      if (patch.traveler_ids) {
        const ids = this.checkTravelers(patch.traveler_ids);
        if (!ids.length) throw badRequest('Eine Reise braucht mindestens einen Reisenden.');
        const before = this.travelerIds(tripId);
        travelersChanged = before.length !== ids.length || before.some((id) => !ids.includes(id));
        this.db.run('DELETE FROM trip_travelers WHERE trip_id = ?', tripId);
        for (const u of ids) this.db.run('INSERT INTO trip_travelers (trip_id, user_id) VALUES (?, ?)', tripId, u);
      }
      this.extendDates(tripId);
    });
    if (travelersChanged) this.hooks.travelersChanged(tripId);
    return this.getTrip(actor, tripId);
  }

  /** Adds travelers without removing anyone (mail import: matched passengers). Returns the added ids. */
  addTravelers(actor: Actor, tripId: string, userIds: string[]): string[] {
    this.requireEditable(actor, tripId);
    const before = this.travelerIds(tripId);
    const added = this.checkTravelers(userIds).filter((id) => !before.includes(id));
    for (const u of added) this.db.run('INSERT INTO trip_travelers (trip_id, user_id) VALUES (?, ?)', tripId, u);
    if (added.length) this.hooks.travelersChanged(tripId);
    return added;
  }

  deleteTrip(actor: Actor, tripId: string): { attachmentIds: string[] } {
    this.requireEditable(actor, tripId);
    const segs = this.db.all<SegmentRow>('SELECT * FROM segments WHERE trip_id = ?', tripId);
    const attachmentIds = this.db.all<{ id: string }>('SELECT id FROM attachments WHERE trip_id = ?', tripId).map((r) => r.id);
    this.db.run('DELETE FROM trips WHERE id = ?', tripId);
    for (const s of segs) this.hooks.segmentRemoved(s);
    return { attachmentIds };
  }

  /** Trip dates grow to cover every segment (never shrink on their own). */
  extendDates(tripId: string): void {
    const t = this.requireTrip(tripId);
    const dates = this.db
      .all<{ d: string | null }>(
        'SELECT substr(start_local, 1, 10) AS d FROM segments WHERE trip_id = ? UNION ALL SELECT substr(end_local, 1, 10) FROM segments WHERE trip_id = ?',
        tripId,
        tripId,
      )
      .map((r) => r.d)
      .filter((d): d is string => !!d)
      .sort();
    if (!dates.length) return;
    const start = !t.start_date || dates[0]! < t.start_date ? dates[0]! : t.start_date;
    const end = !t.end_date || dates.at(-1)! > t.end_date ? dates.at(-1)! : t.end_date;
    if (start !== t.start_date || end !== t.end_date) this.db.run('UPDATE trips SET start_date = ?, end_date = ? WHERE id = ?', start, end, tripId);
  }

  // ---- segments ---------------------------------------------------------------------

  /** Flights without a zone get it from the airport (IATA table): local times stay right in ICS and AirTrail. */
  private withAirportZones(s: SegmentInput): SegmentInput {
    if (s.type !== 'flight') return s;
    return {
      ...s,
      start_tz: s.start_tz ?? (s.start_local ? airportZone(s.from_code) : null),
      end_tz: s.end_tz ?? (s.end_local ? airportZone(s.to_code) : null),
    };
  }

  private validateSegment(s: SegmentInput): void {
    if (s.start_local && s.end_local) {
      const a = utcOf(s.start_local, s.start_tz);
      const b = utcOf(s.end_local, s.end_tz ?? s.start_tz);
      if (a && b && b < a && s.end_local.slice(0, 10) < s.start_local.slice(0, 10)) throw badRequest('Das Ende liegt vor dem Beginn.');
    }
  }

  addSegment(actor: Actor, tripId: string, input: SegmentInput, source: Source = 'manual'): SegmentView {
    this.requireEditable(actor, tripId);
    input = this.withAirportZones(input);
    this.validateSegment(input);
    const id = randomUUID();
    const values = SEGMENT_COLUMNS.map((c) => (c === 'title' ? autoTitle(input) : input[c]));
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO segments (id, trip_id, source, ${SEGMENT_COLUMNS.join(', ')}) VALUES (?, ?, ?, ${SEGMENT_COLUMNS.map(() => '?').join(', ')})`,
        id,
        tripId,
        source,
        ...values,
      );
      this.extendDates(tripId);
      this.touch(tripId);
    });
    this.hooks.segmentChanged(id);
    return segmentView(this.requireSegment(id));
  }

  getSegment(segmentId: string): SegmentView {
    return segmentView(this.requireSegment(segmentId));
  }

  updateSegment(actor: Actor, segmentId: string, patch: SegmentPatch): SegmentView {
    const s = this.requireSegment(segmentId);
    this.requireEditable(actor, s.trip_id);
    const merged = { ...s } as unknown as SegmentInput;
    for (const c of SEGMENT_COLUMNS) if (patch[c] !== undefined) (merged as Record<string, unknown>)[c] = patch[c];
    if (patch.title === null || (patch.title === undefined && !s.title)) merged.title = null;
    merged.title = autoTitle(merged);
    Object.assign(merged, this.withAirportZones(merged));
    this.validateSegment(merged);
    this.db.tx(() => {
      this.db.run(
        `UPDATE segments SET ${SEGMENT_COLUMNS.map((c) => `${c} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        ...SEGMENT_COLUMNS.map((c) => merged[c]),
        segmentId,
      );
      this.extendDates(s.trip_id);
      this.touch(s.trip_id);
    });
    this.hooks.segmentChanged(segmentId);
    return segmentView(this.requireSegment(segmentId));
  }

  deleteSegment(actor: Actor, segmentId: string): void {
    const s = this.requireSegment(segmentId);
    this.requireEditable(actor, s.trip_id);
    this.db.run('DELETE FROM segments WHERE id = ?', segmentId);
    this.touch(s.trip_id);
    this.hooks.segmentRemoved(s);
  }

  /**
   * Moves a segment (with its attachments) into another trip, or into a new one with the same
   * travelers. The old trip shrinks back where only this segment had stretched it.
   */
  moveSegment(actor: Actor, segmentId: string, to: { tripId?: string; newTripTitle?: string }): { segment: SegmentView; trip: TripView } {
    const seg = this.requireSegment(segmentId);
    const from = this.requireEditable(actor, seg.trip_id);
    if (!to.tripId && !to.newTripTitle?.trim()) throw badRequest('Bitte eine Reise wählen oder einen Titel für die neue Reise angeben.');
    if (to.tripId === from.id) throw badRequest('Der Eintrag ist schon in dieser Reise.');
    let targetId = to.tripId ?? null;
    this.db.tx(() => {
      if (targetId) this.requireEditable(actor, targetId);
      else {
        const dates = [seg.start_local, seg.end_local]
          .filter((d): d is string => !!d)
          .map((d) => d.slice(0, 10))
          .sort();
        targetId = this.createTrip(actor, {
          title: to.newTripTitle!.trim().slice(0, 200),
          destination: null,
          start_date: dates[0] ?? null,
          end_date: dates.at(-1) ?? null,
          notes: null,
          traveler_ids: this.travelerIds(from.id),
        }).id;
      }
      this.db.run(`UPDATE segments SET trip_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, targetId, segmentId);
      this.moveAttachments(segmentId, targetId!);
      this.extendDates(targetId!);
      this.shrinkAfterMove(from, seg);
      this.touch(from.id);
      this.touch(targetId!);
    });
    // Travelers may differ: AirTrail follows the new trip.
    this.hooks.segmentChanged(segmentId);
    return { segment: segmentView(this.requireSegment(segmentId)), trip: this.getTrip(actor, targetId!) };
  }

  /**
   * Attachments go along with a moved segment. One that other segments of the old trip still use
   * stays there and the new trip gets its own copy (attachments belong to one trip).
   */
  private moveAttachments(segmentId: string, targetTripId: string): void {
    for (const a of this.db.all<AttachmentRow>(
      'SELECT a.* FROM attachments a JOIN attachment_segments l ON l.attachment_id = a.id WHERE l.segment_id = ?',
      segmentId,
    )) {
      const shared = this.db.get('SELECT 1 FROM attachment_segments WHERE attachment_id = ? AND segment_id != ?', a.id, segmentId);
      if (!shared) {
        this.db.run('UPDATE attachments SET trip_id = ? WHERE id = ?', targetTripId, a.id);
        continue;
      }
      if (!this.copyAttachment) throw new Error('copyAttachment not wired');
      const copy = this.copyAttachment(a, targetTripId);
      this.db.run('DELETE FROM attachment_segments WHERE attachment_id = ? AND segment_id = ?', a.id, segmentId);
      this.db.run('INSERT OR IGNORE INTO attachment_segments (attachment_id, segment_id) VALUES (?, ?)', copy, segmentId);
    }
  }

  /** Set by AttachmentService (files live there): copies a file into another trip, returns the new id. */
  copyAttachment: ((a: AttachmentRow, tripId: string) => string) | null = null;

  /** Undo the stretching a moved segment caused: a boundary it defined moves back to the remaining segments. */
  private shrinkAfterMove(trip: TripRow, moved: SegmentRow): void {
    const remaining = this.db
      .all<{ d: string | null }>(
        'SELECT substr(start_local, 1, 10) AS d FROM segments WHERE trip_id = ? UNION ALL SELECT substr(end_local, 1, 10) FROM segments WHERE trip_id = ?',
        trip.id,
        trip.id,
      )
      .map((r) => r.d)
      .filter((d): d is string => !!d)
      .sort();
    if (!remaining.length || !trip.start_date || !trip.end_date) return;
    const movedDates = [moved.start_local, moved.end_local].filter((d): d is string => !!d).map((d) => d.slice(0, 10));
    let start = trip.start_date;
    let end = trip.end_date;
    if (movedDates.includes(start) && remaining[0]! > start) start = remaining[0]!;
    if (movedDates.includes(end) && remaining.at(-1)! < end) end = remaining.at(-1)!;
    if (start !== trip.start_date || end !== trip.end_date) this.db.run('UPDATE trips SET start_date = ?, end_date = ? WHERE id = ?', start, end, trip.id);
  }

  private touch(tripId: string): void {
    this.db.run(`UPDATE trips SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, tripId);
  }

  // ---- for AirTrail sync --------------------------------------------------------------

  rawSegment(segmentId: string): SegmentRow | undefined {
    return this.db.get<SegmentRow>('SELECT * FROM segments WHERE id = ?', segmentId);
  }

  setAirtrailState(segmentId: string, ids: Record<string, string>, error: string | null): void {
    this.db.run('UPDATE segments SET airtrail_ids = ?, airtrail_error = ? WHERE id = ?', JSON.stringify(ids), error, segmentId);
  }

  /** AirTrail flight ids a user's other segments already use – never link one flight twice. */
  linkedAirtrailIds(userId: string, exceptSegmentId: string): Set<string> {
    const rows = this.db.all<{ airtrail_ids: string }>(
      `SELECT airtrail_ids FROM segments WHERE id != ? AND airtrail_ids LIKE ?`,
      exceptSegmentId,
      `%${userId}%`,
    );
    const ids = new Set<string>();
    for (const r of rows) {
      const id = (JSON.parse(r.airtrail_ids) as Record<string, string>)[userId];
      if (id) ids.add(id);
    }
    return ids;
  }

  flightSegmentIds(tripId: string): string[] {
    return this.db.all<{ id: string }>(`SELECT id FROM segments WHERE trip_id = ? AND (type = 'flight' OR airtrail_ids != '{}')`, tripId).map((r) => r.id);
  }

  flightSegmentIdsOfUser(userId: string): string[] {
    return this.db
      .all<{ id: string }>(`SELECT s.id FROM segments s JOIN trip_travelers x ON x.trip_id = s.trip_id WHERE x.user_id = ? AND s.type = 'flight'`, userId)
      .map((r) => r.id);
  }
}
