import type { FastifyBaseLogger } from 'fastify';
import { normNumber } from '../service/matching.js';
import type { SegmentRow, TripHooks, TripService } from '../service/trips.js';
import type { UserService } from '../service/users.js';
import { hasTime, localToIsoOffset } from '../time.js';
import { AirTrailClient, AirTrailError, type AirTrailFlight, type FlightBody } from './client.js';

/** "LH 2010" → { airline: "LH", number: "LH2010" }; "EW9461" → { airline: "EW", … }. */
export function splitFlightNumber(number: string | null, carrier: string | null): { airline: string | null; number: string | null } {
  const n = normNumber(number);
  // IATA airline codes have two characters (may contain a digit, e.g. "U2"), ICAO codes three letters.
  const m = /^([A-Z0-9]{2}|[A-Z]{3})(\d{1,5}[A-Z]?)$/.exec(n);
  const airline = m?.[1] || (carrier && /^[A-Z0-9]{2,3}$/i.test(carrier.trim()) ? carrier.trim().toUpperCase() : null);
  return { airline, number: n || null };
}

/** One seat per traveler when the booking lists as many seats as there are travelers; one traveler gets the whole field. */
function seatFor(seat: string | null, index: number, count: number): string | undefined {
  if (!seat) return undefined;
  if (count === 1) return seat.slice(0, 20);
  const parts = seat.split(/[,/;]\s*|\s+/).filter(Boolean);
  return parts.length === count ? parts[index]!.slice(0, 20) : undefined;
}

const code = (a: { iata: string | null; icao: string | null } | null | undefined) => [a?.iata, a?.icao].map((c) => c?.toUpperCase()).filter(Boolean);

/**
 * An AirTrail flight of this user that is the same flight as the segment – so Trips links it instead
 * of creating a duplicate: same day, same airports (IATA or ICAO), the user is a passenger, and the
 * flight number matches if both have one. Flights already linked to another segment are skipped.
 */
export function findExistingFlight(
  flights: AirTrailFlight[],
  want: { date: string; from: string; to: string; number: string | null; airtrailUserId: string },
  linked: Set<string>,
): AirTrailFlight | null {
  const candidates = flights.filter(
    (f) =>
      !linked.has(String(f.id)) &&
      String(f.date).slice(0, 10) === want.date &&
      code(f.from).includes(want.from.toUpperCase()) &&
      code(f.to).includes(want.to.toUpperCase()) &&
      f.passengers.some((p) => p.user?.id === want.airtrailUserId),
  );
  const num = normNumber(want.number);
  const same = candidates.filter((f) => normNumber(f.flightNumber) === num && num);
  const open = candidates.filter((f) => !normNumber(f.flightNumber) || !num);
  return same[0] ?? open[0] ?? null;
}

/**
 * PUT replaces the whole flight in AirTrail. So the update starts from what AirTrail has – aircraft,
 * gates, terminals, other passengers stay – and only Trips' fields and the user's own passenger
 * entry are taken over. An empty seat in Trips keeps the seat from AirTrail.
 */
export function mergeForUpdate(existing: AirTrailFlight, ours: FlightBody, airtrailUserId: string): FlightBody {
  const mine = ours.passengers[0]!;
  const passengers = existing.passengers.map((p) => ({
    ...(p.id !== undefined ? { id: p.id } : {}),
    userId: p.user?.id ?? null,
    guestName: p.user ? null : (p.guestName ?? null),
    seat: p.seat ?? null,
    seatNumber: p.seatNumber ?? null,
    seatClass: p.seatClass ?? null,
    flightReason: p.flightReason ?? null,
  }));
  const own = passengers.find((p) => p.userId === airtrailUserId);
  if (own) own.seatNumber = mine.seatNumber ?? own.seatNumber;
  else passengers.push({ userId: airtrailUserId, guestName: null, seat: null, seatNumber: mine.seatNumber ?? null, seatClass: null, flightReason: null });
  return {
    departureScheduled: existing.departureScheduled ?? null,
    arrivalScheduled: existing.arrivalScheduled ?? null,
    takeoffScheduled: existing.takeoffScheduled ?? null,
    takeoffActual: existing.takeoffActual ?? null,
    landingScheduled: existing.landingScheduled ?? null,
    landingActual: existing.landingActual ?? null,
    duration: existing.duration ?? null,
    departureTerminal: existing.departureTerminal ?? null,
    departureGate: existing.departureGate ?? null,
    arrivalTerminal: existing.arrivalTerminal ?? null,
    arrivalGate: existing.arrivalGate ?? null,
    aircraftReg: existing.aircraftReg ?? null,
    aircraftId: existing.aircraft?.id ?? null,
    airlineId: existing.airline?.id ?? null,
    departure: existing.departure ?? null,
    arrival: existing.arrival ?? null,
    flightNumber: existing.flightNumber ?? null,
    // A note written in AirTrail wins over Trips' generated one.
    note: existing.note && !existing.note.endsWith('aus Trips') ? existing.note : (ours.note ?? null),
    // Trips' values win where it has one; a field Trips leaves out keeps AirTrail's value.
    ...Object.fromEntries(Object.entries(ours).filter(([k, v]) => v !== undefined && k !== 'note' && k !== 'passengers')),
    date: ours.date,
    datePrecision: ours.datePrecision,
    fromId: ours.fromId,
    toId: ours.toId,
    passengers,
  };
}

const LIST_TTL_MS = 10 * 60_000;

/**
 * Keeps AirTrail in step with trips: one AirTrail flight per flight segment and traveler with an
 * API key. Jobs run one at a time in a queue and read the current state when they run, so a burst
 * of changes ends in the right state. Never blocks or fails the request that caused it.
 */
export class AirTrailSync implements TripHooks {
  private queue: Promise<void> = Promise.resolve();
  /**
   * The user's AirTrail flights, fetched once per batch: valid while the queue keeps working (an
   * import touches many flights), dropped as soon as it runs empty – so a flight just entered in
   * AirTrail by hand is seen by the next change.
   */
  private lists = new Map<string, { at: number; flights: AirTrailFlight[] }>();
  private pending = 0;

  constructor(
    readonly client: AirTrailClient | null,
    private readonly trips: TripService,
    private readonly users: UserService,
    private readonly log: FastifyBaseLogger,
  ) {}

  get enabled(): boolean {
    return !!this.client;
  }

  private enqueue(name: string, job: () => Promise<void>): void {
    if (!this.client) return;
    this.pending++;
    this.queue = this.queue
      .then(job)
      .catch((err) => this.log.warn({ err: (err as Error).message, job: name }, 'AirTrail-Sync fehlgeschlagen'))
      .finally(() => {
        if (--this.pending === 0) this.lists.clear();
      });
  }

  /** Resolves when everything queued so far is done (tests, shutdown). */
  idle(): Promise<void> {
    return this.queue;
  }

  segmentChanged(segmentId: string): void {
    this.enqueue('segment', () => this.reconcile(segmentId));
  }

  segmentRemoved(segment: Pick<SegmentRow, 'id' | 'airtrail_ids'>): void {
    const ids = JSON.parse(segment.airtrail_ids || '{}') as Record<string, string>;
    if (!Object.keys(ids).length) return;
    this.enqueue('delete', async () => {
      const done = new Set<string>();
      for (const [userId, flightId] of Object.entries(ids)) {
        const key = this.users.airtrailKey(userId);
        if (!key || done.has(flightId)) continue;
        await this.client!.deleteFlight(key, flightId);
        this.forget(key, flightId);
        done.add(flightId);
      }
    });
  }

  travelersChanged(tripId: string): void {
    for (const id of this.trips.flightSegmentIds(tripId)) this.segmentChanged(id);
  }

  /** After a user stored a (new) key: all their flights, old ones included. */
  userKeyChanged(userId: string): void {
    for (const id of this.trips.flightSegmentIdsOfUser(userId)) this.segmentChanged(id);
  }

  private async flightsOf(key: string): Promise<AirTrailFlight[]> {
    const hit = this.lists.get(key);
    if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.flights;
    const flights = await this.client!.listFlights(key);
    this.lists.set(key, { at: Date.now(), flights });
    return flights;
  }

  /** Keeps the cached list current without fetching it again after each change. */
  private remember(key: string, id: string, body: FlightBody, seg: SegmentRow, airtrailUserId: string): void {
    this.lists.get(key)?.flights.push({
      id,
      date: body.date,
      flightNumber: (body.flightNumber as string | undefined) ?? null,
      from: { id: body.fromId, iata: seg.from_code, icao: null },
      to: { id: body.toId, iata: seg.to_code, icao: null },
      passengers: [{ user: { id: airtrailUserId } }],
    });
  }

  private forget(key: string, id: string): void {
    const hit = this.lists.get(key);
    if (hit) hit.flights = hit.flights.filter((f) => String(f.id) !== id);
  }

  private async body(key: string, seg: SegmentRow, passengers: { userId: string; seatNumber?: string }[]): Promise<FlightBody> {
    const c = this.client!;
    if (!seg.from_code || !seg.to_code) throw new AirTrailError(400, 'Abflug- oder Zielflughafen (IATA) fehlt');
    const day = (seg.start_local ?? seg.end_local)?.slice(0, 10);
    if (!day) throw new AirTrailError(400, 'Datum fehlt');
    const [from, to] = [await c.airport(key, seg.from_code), await c.airport(key, seg.to_code)];
    if (!from) throw new AirTrailError(400, `Flughafen ${seg.from_code} ist AirTrail unbekannt`);
    if (!to) throw new AirTrailError(400, `Flughafen ${seg.to_code} ist AirTrail unbekannt`);
    const { airline, number } = splitFlightNumber(seg.number, seg.carrier);
    const airlineRow = airline ? await c.airline(key, airline).catch(() => null) : null;
    const body: FlightBody = {
      date: day,
      datePrecision: 'day',
      fromId: from.id,
      toId: to.id,
      passengers,
    };
    if (seg.start_local && hasTime(seg.start_local)) body.departure = localToIsoOffset(seg.start_local, seg.start_tz ?? from.timezone);
    if (seg.end_local && hasTime(seg.end_local)) body.arrival = localToIsoOffset(seg.end_local, seg.end_tz ?? to.timezone);
    if (airlineRow) body.airlineId = airlineRow.id;
    if (number) body.flightNumber = number;
    const note = [seg.booking_ref && `Buchung ${seg.booking_ref}`, 'aus Trips'].filter(Boolean).join(' · ');
    body.note = note;
    return body;
  }

  async reconcile(segmentId: string): Promise<void> {
    const seg = this.trips.rawSegment(segmentId);
    if (!seg) return;
    const ids = JSON.parse(seg.airtrail_ids || '{}') as Record<string, string>;
    const travelers = this.trips.travelerIds(seg.trip_id);
    const withKey = travelers
      .map((id) => ({ id, user: this.users.get(id), key: this.users.airtrailKey(id) }))
      .filter((t): t is { id: string; user: NonNullable<typeof t.user>; key: string } => !!t.key && !!t.user?.airtrail_user_id);
    const errors: string[] = [];
    const nameOf = (id: string) => this.users.get(id)?.name ?? id;

    // Remove: no longer a flight, or the traveler left the trip. A flight another traveler of this
    // segment shares stays in AirTrail – only the link goes.
    for (const [userId, flightId] of Object.entries(ids)) {
      if (seg.type === 'flight' && travelers.includes(userId)) continue;
      const key = this.users.airtrailKey(userId);
      const shared = Object.entries(ids).some(([other, id]) => other !== userId && id === flightId);
      try {
        if (key && !shared) {
          await this.client!.deleteFlight(key, flightId);
          this.forget(key, flightId);
        }
        delete ids[userId];
      } catch (err) {
        errors.push(`${nameOf(userId)}: ${(err as Error).message}`);
      }
    }

    if (seg.type === 'flight') {
      for (const [i, t] of withKey.entries()) {
        try {
          const body = await this.body(t.key, seg, [{ userId: t.user.airtrail_user_id!, seatNumber: seatFor(seg.seat, i, withKey.length) }]);
          if (body.passengers[0]!.seatNumber === undefined) delete body.passengers[0]!.seatNumber;
          const airtrailUserId = t.user.airtrail_user_id!;
          const linkedId = ids[t.id];
          let current: AirTrailFlight | null = null;
          if (linkedId) {
            try {
              current = await this.client!.getFlight(t.key, linkedId);
            } catch (err) {
              if (!(err instanceof AirTrailError && err.status === 404)) throw err;
            }
          }
          if (!current) {
            // Not linked yet (or deleted in AirTrail): is this flight already there? Then link it.
            const linked = this.trips.linkedAirtrailIds(t.id, segmentId);
            const found = findExistingFlight(
              await this.flightsOf(t.key),
              { date: body.date, from: seg.from_code!, to: seg.to_code!, number: seg.number, airtrailUserId },
              linked,
            );
            // The list may be a few minutes old: read the match fresh before linking it.
            if (found) {
              try {
                current = await this.client!.getFlight(t.key, String(found.id));
              } catch (err) {
                if (!(err instanceof AirTrailError && err.status === 404)) throw err;
                this.forget(t.key, String(found.id));
              }
            }
          }
          if (current) {
            ids[t.id] = String(current.id);
            await this.client!.updateFlight(t.key, String(current.id), mergeForUpdate(current, body, airtrailUserId));
          } else {
            ids[t.id] = await this.client!.createFlight(t.key, body);
            this.remember(t.key, ids[t.id]!, body, seg, airtrailUserId);
          }
        } catch (err) {
          errors.push(withKey.length > 1 ? `${t.user.name}: ${(err as Error).message}` : (err as Error).message);
        }
      }
    }

    // The segment may have been deleted meanwhile – then clean up what was just created.
    if (!this.trips.rawSegment(segmentId)) {
      this.segmentRemoved({ id: segmentId, airtrail_ids: JSON.stringify(ids) });
      return;
    }
    this.trips.setAirtrailState(segmentId, ids, errors.length ? errors.join('; ') : null);
  }
}

export function createAirTrail(
  url: string | undefined,
  trips: TripService,
  users: UserService,
  log: FastifyBaseLogger,
  fetchImpl?: typeof fetch,
): AirTrailSync {
  return new AirTrailSync(url ? new AirTrailClient(url, fetchImpl) : null, trips, users, log);
}
