import { z } from 'zod';
import { airportZone } from '../airports.js';
import { fixedZone, utcToLocal, zoneOffsetMinutes } from '../time.js';
import type { ExportedTrip } from './exchange.js';
import type { SegmentInput } from './schemas.js';

/**
 * TripIt dump → export format. The dump has, per trip: name, location, dates, flights (UTC times,
 * IATA codes), accommodations (UTC check-in/out plus the local clock time), parkings and "others"
 * (rail, rental car pick-up/drop-off as two entries, restaurants, …). It has no time zones, so
 * zones come from the airports: IATA table for flights, the trip's nearest airport for the rest.
 */

const nul = <T extends z.ZodType>(t: T) => t.nullish();

const Flight = z.object({
  flightCode: z.string(),
  from: z.string(),
  to: z.string(),
  airline: nul(z.string()),
  departUtc: z.string(),
  arriveUtc: z.string(),
  departPlace: nul(z.string()),
  layover: nul(z.string()),
});
const Accommodation = z.object({
  name: z.string(),
  address: nul(z.string()),
  phone: nul(z.string()),
  checkIn: nul(z.string()),
  checkInLocal: nul(z.string()),
  checkOut: nul(z.string()),
  checkOutLocal: nul(z.string()),
  warning: nul(z.string()),
});
const Parking = z.object({ name: z.string(), address: nul(z.string()), phone: nul(z.string()), dropOff: nul(z.string()), pickUp: nul(z.string()) });
const Other = z.object({ type: z.string(), name: z.string(), address: nul(z.string()), start: z.string(), end: nul(z.string()) });
const Trip = z.object({
  tripUuid: z.string(),
  name: z.string(),
  location: nul(z.string()),
  startDate: z.string(),
  endDate: z.string(),
  flights: z.array(Flight).default([]),
  accommodations: z.array(Accommodation).default([]),
  parkings: z.array(Parking).default([]),
  others: z.array(Other).default([]),
});
// Strict: a Trips export also has "trips", but with "format" and "version" next to it.
const Dump = z.union([z.array(z.object({ trips: z.array(Trip) }).strict()), z.object({ trips: z.array(Trip) }).strict()]);

type TTrip = z.infer<typeof Trip>;
type Point = { local: string | null; tz: string | null };

const empty: SegmentInput = {
  type: 'other',
  title: null,
  start_local: null,
  start_tz: null,
  end_local: null,
  end_tz: null,
  from_name: null,
  from_code: null,
  to_name: null,
  to_code: null,
  carrier: null,
  number: null,
  booking_ref: null,
  seat: null,
  address: null,
  notes: null,
};

const isDateOnly = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Where the traveller is: after arriving (check-in, pick-up) or before departing (check-out, drop-off). */
export type Role = 'arrive' | 'depart' | 'any';

/** Fallback for trips without flights (rail, car): the zone the app runs in. */
const HOME_ZONE = process.env.TZ || 'Europe/Berlin';

/** Airports of the trip with the moments the traveller was there. */
function airportMoments(trip: TTrip, role: Role): { code: string; at: number }[] {
  return trip.flights.flatMap((f) => [
    ...(role !== 'arrive' ? [{ code: f.from, at: Date.parse(f.departUtc) }] : []),
    ...(role !== 'depart' ? [{ code: f.to, at: Date.parse(f.arriveUtc) }] : []),
  ]);
}

/**
 * Zones of the trip's airports, most likely first: after arriving you are where the last plane
 * landed, before departing where the next one leaves. Then by distance in time.
 */
function nearbyZones(trip: TTrip, at: number, role: Role): string[] {
  const ranked = airportMoments(trip, role)
    .map((m) => ({
      zone: airportZone(m.code),
      d: Math.abs(m.at - at),
      // arrive: landings before the moment; depart: departures after it.
      fits: role === 'arrive' ? m.at <= at : role === 'depart' ? m.at >= at : true,
    }))
    .filter((m): m is { zone: string; d: number; fits: boolean } => !!m.zone)
    .sort((a, b) => Number(b.fits) - Number(a.fits) || a.d - b.d)
    .map((m) => m.zone);
  return [...new Set(ranked)];
}

/** A UTC moment, optionally with the local clock time TripIt knows ("15:00"), as local time + zone. */
export function toPoint(trip: TTrip, utc: string | null | undefined, clock: string | null = null, role: Role = 'any'): Point {
  if (!utc) return { local: null, tz: null };
  if (isDateOnly(utc)) return { local: utc, tz: null };
  const instant = new Date(utc);
  if (Number.isNaN(instant.getTime())) return { local: null, tz: null };
  const candidates = [...new Set([...nearbyZones(trip, instant.getTime(), role), ...nearbyZones(trip, instant.getTime(), 'any')])];
  const guess = candidates[0] ?? null;
  const m = clock ? /^(\d{1,2}):(\d{2})$/.exec(clock) : null;
  if (m) {
    // Offset from local clock minus UTC clock, folded into −12 h … +14 h.
    let offset = (Number(m[1]) * 60 + Number(m[2]) - (instant.getUTCHours() * 60 + instant.getUTCMinutes())) % 1440;
    if (offset > 14 * 60) offset -= 1440;
    if (offset < -12 * 60) offset += 1440;
    // A named zone whose offset fits beats a fixed "Etc/GMT-2".
    const named = [...candidates, HOME_ZONE].find((z) => zoneOffsetMinutes(instant, z) === offset);
    const tz = named ?? fixedZone(offset) ?? guess;
    if (tz) return { local: utcToLocal(instant, tz), tz };
  }
  const tz = guess ?? HOME_ZONE;
  return { local: utcToLocal(instant, tz), tz };
}

/** "Dusseldorf (DUS)" → "Dusseldorf" */
const placeName = (p: string | null | undefined) => (p ? p.replace(/\s*\([A-Z0-9]{3,4}\)\s*$/, '').trim() || null : null);

/** "EW9754" → "EW 9754" */
export function flightNumber(code: string): string {
  const m = /^([A-Z0-9]{2}|[A-Z]{3})(\d{1,5}[A-Z]?)$/i.exec(code.trim());
  return m ? `${m[1]!.toUpperCase()} ${m[2]}` : code.trim();
}

function flights(trip: TTrip): SegmentInput[] {
  return trip.flights.map((f) => {
    const fromTz = airportZone(f.from);
    const toTz = airportZone(f.to);
    return {
      ...empty,
      type: 'flight',
      number: flightNumber(f.flightCode),
      carrier: f.airline ?? null,
      from_code: f.from.toUpperCase(),
      from_name: placeName(f.departPlace),
      to_code: f.to.toUpperCase(),
      start_local: utcToLocal(new Date(f.departUtc), fromTz ?? 'UTC'),
      start_tz: fromTz ?? 'UTC',
      end_local: utcToLocal(new Date(f.arriveUtc), toTz ?? 'UTC'),
      end_tz: toTz ?? 'UTC',
      notes: f.layover ? `Umstieg danach: ${f.layover}` : null,
    };
  });
}

function hotels(trip: TTrip): SegmentInput[] {
  return trip.accommodations.map((a) => {
    const start = toPoint(trip, a.checkIn, a.checkInLocal, 'arrive');
    const end = toPoint(trip, a.checkOut, a.checkOutLocal, 'depart');
    return {
      ...empty,
      type: 'hotel',
      title: a.name,
      address: a.address ?? null,
      start_local: start.local,
      start_tz: start.tz,
      end_local: end.local,
      end_tz: end.tz,
      notes: [a.phone && `Telefon: ${a.phone}`, a.warning && `TripIt: ${a.warning}`].filter(Boolean).join('\n') || null,
    };
  });
}

function parkings(trip: TTrip): SegmentInput[] {
  return trip.parkings.map((p) => {
    // The car waits at the airport of the first departure – drop-off and pick-up both happen there.
    const firstDeparture = [...trip.flights].sort((a, b) => a.departUtc.localeCompare(b.departUtc))[0];
    const zone = airportZone(firstDeparture?.from) ?? HOME_ZONE;
    const at = (utc: string | null | undefined): Point =>
      !utc ? { local: null, tz: null } : isDateOnly(utc) ? { local: utc, tz: null } : { local: utcToLocal(new Date(utc), zone), tz: zone };
    const start = at(p.dropOff);
    const end = at(p.pickUp);
    return {
      ...empty,
      type: 'parking',
      title: p.name,
      address: p.address ?? null,
      start_local: start.local,
      start_tz: start.tz,
      end_local: end.local,
      end_tz: end.tz,
      notes: p.phone ? `Telefon: ${p.phone}` : null,
    };
  });
}

/** Rail, rental cars (pick-up + drop-off paired into one segment), everything else as "other". */
function others(trip: TTrip): SegmentInput[] {
  const out: SegmentInput[] = [];
  let openCar: SegmentInput | null = null;
  const sorted = [...trip.others].sort((a, b) => a.start.localeCompare(b.start));
  for (const o of sorted) {
    const start = toPoint(trip, o.start);
    const end = toPoint(trip, o.end);
    if (o.type === 'Car Rental') {
      const company = o.name.includes(':') ? o.name.slice(o.name.indexOf(':') + 1).trim() : o.name;
      if (/^pick\s*up/i.test(o.name)) {
        if (openCar) out.push(openCar);
        openCar = {
          ...empty,
          type: 'car',
          carrier: company || null,
          from_name: o.address ?? null,
          address: o.address ?? null,
          start_local: start.local,
          start_tz: start.tz,
        };
      } else if (openCar && /^drop\s*off/i.test(o.name)) {
        out.push({ ...openCar, to_name: o.address ?? null, end_local: start.local, end_tz: start.tz });
        openCar = null;
      } else {
        out.push({ ...empty, type: 'car', carrier: company || null, to_name: o.address ?? null, end_local: start.local, end_tz: start.tz });
      }
      continue;
    }
    if (o.type === 'Rail') {
      // "DB - Aachen Hbf to Düsseldorf Flughafen"
      const m = /^(.+?)\s+-\s+(.+?)\s+to\s+(.+)$/.exec(o.name);
      out.push({
        ...empty,
        type: 'train',
        title: m ? null : o.name,
        carrier: m ? m[1]!.trim() : null,
        from_name: m ? m[2]!.trim() : null,
        to_name: m ? m[3]!.trim() : null,
        start_local: start.local,
        start_tz: start.tz,
        end_local: end.local,
        end_tz: end.tz,
      });
      continue;
    }
    const label: Record<string, string> = { Restaurant: 'Restaurant', Activity: 'Aktivität', Transportation: 'Transfer', 'Ground Transportation': 'Transfer' };
    out.push({
      ...empty,
      type: 'other',
      title: o.name,
      address: o.address ?? null,
      start_local: start.local,
      start_tz: start.tz,
      end_local: end.local,
      end_tz: end.tz,
      notes: label[o.type] ?? o.type,
    });
  }
  if (openCar) out.push(openCar);
  return out;
}

/** null when the data is not a TripIt dump. */
export function tripitToExport(data: unknown): ExportedTrip[] | null {
  const parsed = Dump.safeParse(data);
  if (!parsed.success) return null;
  const trips = Array.isArray(parsed.data) ? parsed.data.flatMap((d) => d.trips) : parsed.data.trips;
  return trips.map((t) => ({
    title: t.name,
    destination: t.location ?? null,
    start_date: t.startDate,
    end_date: t.endDate,
    notes: null,
    travelers: [],
    segments: [...flights(t), ...hotels(t), ...parkings(t), ...others(t)].map((s) => ({ ...s, source: 'import' })),
  }));
}
