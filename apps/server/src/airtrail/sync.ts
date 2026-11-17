import type { FastifyBaseLogger } from 'fastify';
import { normNumber } from '../service/matching.js';
import type { SegmentRow, TripHooks, TripService } from '../service/trips.js';
import type { UserService } from '../service/users.js';
import { hasTime, localToIsoOffset } from '../time.js';
import { AirTrailClient, AirTrailError, type FlightBody } from './client.js';

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
  if (count === 1) return seat.slice(0, 10);
  const parts = seat.split(/[,/;]\s*|\s+/).filter(Boolean);
  return parts.length === count ? parts[index]!.slice(0, 10) : undefined;
}

/**
 * Keeps AirTrail in step with trips: one AirTrail flight per flight segment and traveler with an
 * API key. Jobs run one at a time in a queue and read the current state when they run, so a burst
 * of changes ends in the right state. Never blocks or fails the request that caused it.
 */
export class AirTrailSync implements TripHooks {
  private queue: Promise<void> = Promise.resolve();

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
    this.queue = this.queue.then(job).catch((err) => this.log.warn({ err: (err as Error).message, job: name }, 'AirTrail-Sync fehlgeschlagen'));
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
      for (const [userId, flightId] of Object.entries(ids)) {
        const key = this.users.airtrailKey(userId);
        if (key) await this.client!.deleteFlight(key, flightId);
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

    // Remove: no longer a flight, or the traveler left the trip.
    for (const [userId, flightId] of Object.entries(ids)) {
      if (seg.type === 'flight' && travelers.includes(userId)) continue;
      const key = this.users.airtrailKey(userId);
      try {
        if (key) await this.client!.deleteFlight(key, flightId);
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
          const existing = ids[t.id];
          if (existing) {
            try {
              await this.client!.updateFlight(t.key, existing, body);
            } catch (err) {
              if (!(err instanceof AirTrailError && err.status === 404)) throw err;
              ids[t.id] = await this.client!.createFlight(t.key, body);
            }
          } else {
            ids[t.id] = await this.client!.createFlight(t.key, body);
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
