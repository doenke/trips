import { addDays, daysBetween } from '../time.js';
import type { SegmentType } from './schemas.js';

/** Which existing trip a set of dates belongs to, and which segment an incoming one updates. */

export interface TripCandidate {
  id: string;
  start_date: string | null;
  end_date: string | null;
  travelerIds: string[];
  /** Day the trip returns to where it started (see returnDay) – then the trip is complete. */
  returnDay?: string | null;
}

interface Leg {
  type: SegmentType;
  start_local: string | null;
  end_local: string | null;
  from_code: string | null;
  from_name: string | null;
  to_code: string | null;
  to_name: string | null;
}

const place = (code: string | null, name: string | null) => [code?.trim().toUpperCase(), normText(name)].filter((v): v is string => !!v);

/**
 * The day the trip gets back to where its first flight or train left from (DUS → VIE … VIE → DUS:
 * the day of the return). null while there is no way back yet – or it ends somewhere else.
 */
export function returnDay(segments: Leg[]): string | null {
  const legs = segments
    .filter((s) => (s.type === 'flight' || s.type === 'train') && s.start_local)
    .sort((a, b) => a.start_local!.localeCompare(b.start_local!));
  const first = legs[0];
  if (!first) return null;
  const origin = place(first.from_code, first.from_name);
  if (!origin.length) return null;
  const back = legs
    .slice(1)
    .filter((l) => place(l.to_code, l.to_name).some((p) => origin.includes(p)))
    .at(-1);
  return back ? (back.end_local ?? back.start_local)!.slice(0, 10) : null;
}

/** Gap in days between two date ranges (0 = they overlap or touch). */
export function rangeGap(aStart: string, aEnd: string, bStart: string, bEnd: string): number {
  if (aEnd < bStart) return daysBetween(aEnd, bStart);
  if (bEnd < aStart) return daysBetween(bEnd, aStart);
  return 0;
}

/**
 * Does [start, end] belong to the trip? While the way back is still missing, dates may lie up to
 * ±grace days around the trip. Once the trip returns to where it started, it is complete: only what
 * begins by the day of the return still belongs (the airport hotel that night), plus one day before
 * the start (the hotel or parking the evening before departure). The next day is a new trip.
 */
export function fitsTrip(t: TripCandidate, start: string, end: string, graceDays: number): boolean {
  if (!t.start_date || !t.end_date) return false;
  if (t.returnDay) return start <= t.returnDay && end >= addDays(t.start_date, -1);
  return addDays(t.start_date, -graceDays) <= end && addDays(t.end_date, graceDays) >= start;
}

/**
 * Picks the trip for [start, end] among the candidates (see fitsTrip). Preferred is the trip
 * sharing the most travelers, then the one closest in time.
 */
export function pickTrip<T extends TripCandidate>(candidates: T[], start: string, end: string, travelerIds: string[], graceDays: number): T | null {
  const scored = candidates
    .filter((t) => fitsTrip(t, start, end, graceDays))
    .map((t) => ({
      t,
      shared: t.travelerIds.filter((id) => travelerIds.includes(id)).length,
      gap: rangeGap(t.start_date!, t.end_date!, start, end),
    }))
    .filter((s) => s.shared > 0)
    .sort((a, b) => b.shared - a.shared || a.gap - b.gap || a.t.start_date!.localeCompare(b.t.start_date!));
  return scored[0]?.t ?? null;
}

export interface SegmentKey {
  type: SegmentType;
  title: string | null;
  start_local: string | null;
  number: string | null;
  booking_ref: string | null;
  carrier?: string | null;
}

export function normNumber(v: string | null | undefined): string {
  return (v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normText(v: string | null | undefined): string {
  return (v ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

const day = (s: SegmentKey) => (s.start_local ? s.start_local.slice(0, 10) : null);

/**
 * Is `incoming` the same booking as `existing` (→ update instead of a new segment)?
 * - flight/train: same day and same flight/train number; without numbers same day and booking number.
 *   (A booking number alone is not enough: one PNR often covers outbound, connection and return.)
 * - parking: same booking number; otherwise same provider on the same entry day.
 * - hotel/car/other: same booking number; otherwise same title on the same day.
 * A cancellation without a date matches on number / booking number alone.
 */
export function sameSegment(existing: SegmentKey, incoming: SegmentKey): boolean {
  if (existing.type !== incoming.type) return false;
  const sameDay = !day(incoming) || day(existing) === day(incoming);
  const num = normNumber(incoming.number);
  const ref = normNumber(incoming.booking_ref);
  if (incoming.type === 'flight' || incoming.type === 'train') {
    if (num && normNumber(existing.number)) return sameDay && num === normNumber(existing.number);
    return sameDay && !!ref && ref === normNumber(existing.booking_ref);
  }
  if (ref && normNumber(existing.booking_ref)) return ref === normNumber(existing.booking_ref);
  const provider = (s: SegmentKey) => normText(s.title) || normText(s.carrier);
  return !!day(incoming) && sameDay && !!provider(incoming) && provider(incoming) === provider(existing);
}

export function findSame<S extends SegmentKey>(segments: S[], incoming: SegmentKey): S | undefined {
  return segments.find((s) => sameSegment(s, incoming));
}
