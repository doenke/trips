import { route, timeOf, TYPE_ICON } from './format';
import type { Segment } from './types';

/** One line in the trip's timeline. Hotels, parking and rental cars appear twice: start and end day. */
export interface TimelineEntry {
  key: string;
  day: string;
  time: string | null;
  sort: string;
  icon: string;
  label: string;
  title: string;
  detail: string | null;
  segment: Segment;
  phase: 'single' | 'start' | 'end';
}

const PHASES: Partial<Record<Segment['type'], [string, string]>> = {
  hotel: ['Check-in', 'Check-out'],
  parking: ['Einfahrt', 'Ausfahrt'],
  car: ['Abholung', 'Rückgabe'],
};

export function timelineEntries(segments: Segment[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const s of segments) {
    const icon = TYPE_ICON[s.type];
    const phases = PHASES[s.type];
    if (phases) {
      if (s.start_local)
        out.push({
          key: `${s.id}-start`,
          day: s.start_local.slice(0, 10),
          time: timeOf(s.start_local),
          sort: s.start_utc ?? s.start_local,
          icon,
          label: phases[0],
          title: s.title,
          detail: s.type === 'car' ? (s.from_name ?? s.address) : s.address,
          segment: s,
          phase: 'start',
        });
      if (s.end_local)
        out.push({
          key: `${s.id}-end`,
          day: s.end_local.slice(0, 10),
          time: timeOf(s.end_local),
          sort: s.end_utc ?? s.end_local,
          icon,
          label: phases[1],
          title: s.title,
          detail: s.type === 'car' ? (s.to_name ?? s.address) : null,
          segment: s,
          phase: 'end',
        });
      if (!s.start_local && !s.end_local) out.push(single(s, icon));
      continue;
    }
    out.push(single(s, icon));
  }
  // Date-only entries first within a day, then by instant.
  return out.sort((a, b) => a.day.localeCompare(b.day) || Number(!!a.time) - Number(!!b.time) || a.sort.localeCompare(b.sort));
}

function single(s: Segment, icon: string): TimelineEntry {
  const start = timeOf(s.start_local);
  const end = timeOf(s.end_local);
  const nextDay = s.start_local && s.end_local && s.end_local.slice(0, 10) !== s.start_local.slice(0, 10);
  const times = start && end ? `${start} – ${end}${nextDay ? ' (+1)' : ''}` : null;
  const r = s.type === 'flight' || s.type === 'train' ? route(s) : null;
  return {
    key: s.id,
    day: (s.start_local ?? s.end_local ?? '').slice(0, 10),
    time: start,
    sort: s.start_utc ?? s.start_local ?? '',
    icon,
    label: s.type === 'flight' ? 'Flug' : s.type === 'train' ? 'Zug' : '',
    title: s.title,
    detail: [times, r && !s.title.includes(r) ? r : null, s.type === 'other' ? s.address : null].filter(Boolean).join(' · ') || null,
    segment: s,
    phase: 'single',
  };
}

export function groupByDay(entries: TimelineEntry[]): { day: string; entries: TimelineEntry[] }[] {
  const groups: { day: string; entries: TimelineEntry[] }[] = [];
  for (const e of entries) {
    const last = groups.at(-1);
    if (last && last.day === e.day) last.entries.push(e);
    else groups.push({ day: e.day, entries: [e] });
  }
  return groups;
}
