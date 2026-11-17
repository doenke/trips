import type { Segment, SegmentType } from './types';

export const TYPE_ICON: Record<SegmentType, string> = { flight: '✈️', train: '🚆', hotel: '🏨', car: '🚗', parking: '🅿️', other: '📌' };
export const TYPE_LABEL: Record<SegmentType, string> = {
  flight: 'Flug',
  train: 'Zug',
  hotel: 'Hotel',
  car: 'Mietwagen',
  parking: 'Parkplatz',
  other: 'Sonstiges',
};

const dayFmt = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'long', timeZone: 'UTC' });
const dayYearFmt = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortFmt = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const shortYearFmt = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

const asDate = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`);

/** "Sa., 4. Juli" (with year when it's not this year). */
export function dayLabel(date: string, today = todayLocal()): string {
  return (date.slice(0, 4) === today.slice(0, 4) ? dayFmt : dayYearFmt).format(asDate(date));
}

/** "4. Juli – 14. Juli 2027" */
export function dateRange(start: string | null, end: string | null): string {
  if (!start) return 'ohne Datum';
  if (!end || end === start) return shortYearFmt.format(asDate(start));
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  return `${(sameYear ? shortFmt : shortYearFmt).format(asDate(start))} – ${shortYearFmt.format(asDate(end))}`;
}

export function timeOf(local: string | null): string | null {
  return local && local.length > 10 ? local.slice(11, 16) : null;
}

export function todayLocal(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function daysBetween(a: string, b: string): number {
  return Math.round((asDate(b).getTime() - asDate(a).getTime()) / 86_400_000);
}

/** "in 12 Tagen", "morgen", "heute", "Tag 3 von 10". */
export function countdown(start: string | null, end: string | null, today = todayLocal()): string {
  if (!start) return '';
  const d = daysBetween(today, start);
  if (d > 1) return `in ${d} Tagen`;
  if (d === 1) return 'morgen';
  if (d === 0) return 'heute geht’s los';
  const total = daysBetween(start, end ?? start) + 1;
  const day = daysBetween(start, today) + 1;
  return day <= total ? `unterwegs · Tag ${day} von ${total}` : 'vorbei';
}

export function route(s: Pick<Segment, 'from_code' | 'from_name' | 'to_code' | 'to_name'>): string | null {
  const from = s.from_code ?? s.from_name;
  const to = s.to_code ?? s.to_name;
  return from && to ? `${from} → ${to}` : (from ?? to ?? null);
}

export function fileSize(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Link that opens the address in the phone's map app. */
export function mapsLink(address: string): string {
  const q = encodeURIComponent(address);
  const ua = navigator.userAgent;
  if (/iPhone|iPad|Macintosh/.test(ua)) return `https://maps.apple.com/?q=${q}`;
  if (/Android/.test(ua)) return `geo:0,0?q=${q}`;
  return `https://www.openstreetmap.org/search?query=${q}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toUpperCase();
}

/** A stable soft color per person for the initials fallback. */
export function hue(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
