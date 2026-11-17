import type { SegmentView, TripView } from './service/trips.js';
import { TYPE_ICON } from './service/trips.js';
import { addDays, hasTime, localToUtc } from './time.js';

/** iCalendar (RFC 5545) feed: one all-day event per trip plus events per segment, times in UTC. */

export function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Folds lines longer than 75 octets (UTF-8 safe: never splits a character). */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const len = Buffer.byteLength(ch);
    const limit = out.length ? 74 : 75; // continuation lines start with a space
    if (bytes + len > limit) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += len;
  }
  out.push(current);
  return out.join('\r\n ');
}

function utcStamp(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function dateValue(date: string): string {
  return date.replace(/-/g, '');
}

interface Event {
  uid: string;
  summary: string;
  start: { date: string } | { utc: Date };
  end: { date: string } | { utc: Date };
  location?: string | null;
  description?: string | null;
  url?: string;
}

function eventLines(e: Event, stamp: string): string[] {
  const when = (key: 'DTSTART' | 'DTEND', v: Event['start']) => ('date' in v ? `${key};VALUE=DATE:${dateValue(v.date)}` : `${key}:${utcStamp(v.utc)}`);
  return [
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `DTSTAMP:${stamp}`,
    when('DTSTART', e.start),
    when('DTEND', e.end),
    `SUMMARY:${escapeText(e.summary)}`,
    ...(e.location ? [`LOCATION:${escapeText(e.location)}`] : []),
    ...(e.description ? [`DESCRIPTION:${escapeText(e.description)}`] : []),
    ...(e.url ? [`URL:${e.url}`] : []),
    'END:VEVENT',
  ];
}

/** A point in time (start or end of a segment) as calendar start; date-only values become all-day. */
function at(local: string, tz: string | null, minutes: number): Pick<Event, 'start' | 'end'> {
  if (!hasTime(local)) return { start: { date: local }, end: { date: addDays(local, 1) } };
  const start = localToUtc(local, tz);
  return { start: { utc: start }, end: { utc: new Date(start.getTime() + minutes * 60_000) } };
}

function details(s: SegmentView, url: string): string {
  return [
    s.number && `Nummer: ${s.number}`,
    s.carrier && `Anbieter: ${s.carrier}`,
    s.booking_ref && `Buchungsnummer: ${s.booking_ref}`,
    s.seat && `${s.type === 'hotel' ? 'Zimmer' : s.type === 'parking' ? 'Stellplatz' : 'Sitzplatz'}: ${s.seat}`,
    s.notes,
    url,
  ]
    .filter(Boolean)
    .join('\n');
}

function route(s: SegmentView): string | null {
  const from = s.from_name ?? s.from_code;
  const to = s.to_name ?? s.to_code;
  return from && to ? `${from} → ${to}` : (from ?? to ?? null);
}

export function segmentEvents(s: SegmentView, tripUrl: string): Event[] {
  const icon = TYPE_ICON[s.type];
  const description = details(s, tripUrl);
  const base = { description, url: tripUrl };
  if (s.type === 'hotel' || s.type === 'parking') {
    const [inLabel, outLabel, minutes] = s.type === 'hotel' ? ['Check-in', 'Check-out', 30] : ['Einfahrt', 'Ausfahrt', 15];
    const events: Event[] = [];
    if (s.start_local)
      events.push({
        ...base,
        uid: `${s.id}-in@trips`,
        summary: `${icon} ${inLabel}: ${s.title}`,
        location: s.address,
        ...at(s.start_local, s.start_tz, minutes),
      });
    if (s.end_local)
      events.push({
        ...base,
        uid: `${s.id}-out@trips`,
        summary: `${icon} ${outLabel}: ${s.title}`,
        location: s.address,
        ...at(s.end_local, s.end_tz ?? s.start_tz, minutes),
      });
    return events;
  }
  if (!s.start_local) return [];
  const summary = `${icon} ${s.title}`;
  const location = s.type === 'car' ? (s.address ?? s.from_name) : route(s);
  if (!hasTime(s.start_local)) {
    const endDate = s.end_local ? s.end_local.slice(0, 10) : s.start_local;
    return [{ ...base, uid: `${s.id}@trips`, summary, location, start: { date: s.start_local }, end: { date: addDays(endDate, 1) } }];
  }
  const start = localToUtc(s.start_local, s.start_tz);
  let end = s.end_local && hasTime(s.end_local) ? localToUtc(s.end_local, s.end_tz ?? s.start_tz) : new Date(start.getTime() + 60 * 60_000);
  if (end <= start) end = new Date(start.getTime() + 60 * 60_000);
  return [{ ...base, uid: `${s.id}@trips`, summary, location, start: { utc: start }, end: { utc: end } }];
}

export function buildIcs(trips: TripView[], opts: { publicUrl: string; calendarName?: string; now?: Date }): string {
  const stamp = utcStamp(opts.now ?? new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//trips//Trips//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(opts.calendarName ?? 'Trips')}`,
    'X-PUBLISHED-TTL:PT1H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
  ];
  for (const t of trips) {
    const url = `${opts.publicUrl}/trips/${t.id}`;
    if (t.start_date) {
      lines.push(
        ...eventLines(
          {
            uid: `trip-${t.id}@trips`,
            summary: `🧳 ${t.title}`,
            start: { date: t.start_date },
            end: { date: addDays(t.end_date ?? t.start_date, 1) },
            location: t.destination,
            description: [t.notes, url].filter(Boolean).join('\n'),
            url,
          },
          stamp,
        ),
      );
    }
    for (const s of t.segments) for (const e of segmentEvents(s, url)) lines.push(...eventLines(e, stamp));
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
