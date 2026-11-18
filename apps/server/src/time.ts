/**
 * Local wall-clock times ("2026-03-29T02:30" or "2026-03-29") plus an IANA zone.
 * Everything here uses Intl only – no time zone library.
 */

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

export function isValidLocal(v: string): boolean {
  const m = LOCAL_RE.exec(v);
  if (!m) return false;
  const [, y, mo, d, h, mi] = m;
  const date = new Date(Date.UTC(+y!, +mo! - 1, +d!));
  if (date.getUTCFullYear() !== +y! || date.getUTCMonth() !== +mo! - 1 || date.getUTCDate() !== +d!) return false;
  return h === undefined || (+h <= 23 && +mi! <= 59);
}

export function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function hasTime(local: string): boolean {
  return local.length > 10;
}

export function dateOf(local: string): string {
  return local.slice(0, 10);
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Offset of a zone at an instant, in minutes east of UTC (e.g. +120 for CEST). */
export function zoneOffsetMinutes(instant: Date, tz: string): number {
  const parts = Object.fromEntries(
    formatter(tz)
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/**
 * Wall-clock time in a zone → UTC instant. Times in a DST gap are moved forward
 * (02:30 on a spring-forward day becomes 03:30); ambiguous times take the earlier instant.
 */
export function localToUtc(local: string, tz: string | null | undefined): Date {
  const m = LOCAL_RE.exec(local);
  if (!m) throw new Error(`Ungültige Zeit: ${local}`);
  const [, y, mo, d, h = '00', mi = '00'] = m;
  const wall = Date.UTC(+y!, +mo! - 1, +d!, +h, +mi);
  if (!tz) return new Date(wall);
  // Offsets a day before and after cover any transition near this wall time.
  const before = zoneOffsetMinutes(new Date(wall - 86_400_000), tz);
  const after = zoneOffsetMinutes(new Date(wall + 86_400_000), tz);
  const valid = [before, after].map((o) => wall - o * 60_000).filter((c) => zoneOffsetMinutes(new Date(c), tz) * 60_000 === wall - c);
  // Ambiguous (fall back): the earlier instant. Gap (spring forward): the offset before the gap,
  // which moves the time forward by the gap length.
  return new Date(valid.length ? Math.min(...valid) : wall - before * 60_000);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** "2026-07-01T10:00:00+02:00" – for APIs that want ISO with offset (AirTrail). */
export function localToIsoOffset(local: string, tz: string | null | undefined): string {
  const instant = localToUtc(local, tz);
  const offset = tz ? zoneOffsetMinutes(instant, tz) : 0;
  const shifted = new Date(instant.getTime() + offset * 60_000);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** Today in a zone as YYYY-MM-DD. */
export function todayIn(tz: string, now = new Date()): string {
  const parts = Object.fromEntries(
    formatter(tz)
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** UTC instant → wall-clock time in a zone, as "YYYY-MM-DDTHH:MM". */
export function utcToLocal(instant: Date, tz: string): string {
  const parts = Object.fromEntries(
    formatter(tz)
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** A fixed-offset IANA zone for whole hours ("Etc/GMT-2" is UTC+2 – the sign is inverted by POSIX). */
export function fixedZone(offsetMinutes: number): string | null {
  if (offsetMinutes === 0) return 'UTC';
  if (offsetMinutes % 60 !== 0 || Math.abs(offsetMinutes) > 14 * 60) return null;
  const h = offsetMinutes / 60;
  return `Etc/GMT${h > 0 ? '-' : '+'}${Math.abs(h)}`;
}
