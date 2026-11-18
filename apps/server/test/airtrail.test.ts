import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, textOf } from './helpers.js';

let t: TestApp;
let anna: Awaited<ReturnType<TestApp['login']>>;
let ben: Awaited<ReturnType<TestApp['login']>>;
let tripId: string;
let flightId: string;

const flight = {
  type: 'flight',
  number: 'LH 2010',
  from_code: 'DUS',
  to_code: 'MUC',
  start_local: '2027-05-03T07:00',
  start_tz: 'Europe/Berlin',
  end_local: '2027-05-03T08:10',
  end_tz: 'Europe/Berlin',
  seat: '7C',
  booking_ref: 'ABC123',
};

const segment = async () =>
  (await t.app.inject({ method: 'GET', url: `/api/trips/${tripId}`, headers: anna.headers })).json().segments.find((s: { id: string }) => s.id === flightId);
const ids = () => JSON.parse(t.services.trips.rawSegment(flightId)!.airtrail_ids) as Record<string, string>;

beforeAll(async () => {
  t = await createTestApp();
  anna = await t.login('Anna');
  ben = await t.login('Ben');
  tripId = (await t.app.inject({ method: 'POST', url: '/api/trips', headers: anna.headers, payload: { title: 'München' } })).json().id;
});
afterAll(async () => t?.close());

describe('AirTrail key', () => {
  it('rejects an invalid key and stores a valid one encrypted', async () => {
    const bad = await t.app.inject({ method: 'PUT', url: '/api/me/airtrail', headers: anna.headers, payload: { key: 'wrong-key-123' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain('API-Key ungültig');
    const ok = await t.app.inject({ method: 'PUT', url: '/api/me/airtrail', headers: anna.headers, payload: { key: 'key-anna' } });
    expect(ok.json()).toMatchObject({ connected: true, status: 'verbunden als anna' });
    const row = t.services.users.get(anna.id)!;
    expect(row.airtrail_key).not.toContain('key-anna');
    expect(row.airtrail_user_id).toBe('at-anna');
  });
});

describe('AirTrail sync', () => {
  it('creates a flight with offsets, airport and airline ids', async () => {
    flightId = (await t.app.inject({ method: 'POST', url: `/api/trips/${tripId}/segments`, headers: anna.headers, payload: flight })).json().id;
    await t.idle();
    expect(t.airtrail.flights.size).toBe(1);
    const [id, f] = [...t.airtrail.flights.entries()][0]!;
    expect(ids()).toEqual({ [anna.id]: id });
    expect(f).toMatchObject({
      date: '2027-05-03',
      datePrecision: 'day',
      departure: '2027-05-03T07:00:00+02:00',
      arrival: '2027-05-03T08:10:00+02:00',
      fromId: 1,
      toId: 2,
      airlineId: 10,
      flightNumber: 'LH2010',
      passengers: [{ userId: 'at-anna', seatNumber: '7C' }],
    });
    expect((await segment()).airtrail).toEqual({ users: [anna.id], error: null });
  });

  it('updates with PUT', async () => {
    await t.app.inject({ method: 'PATCH', url: `/api/segments/${flightId}`, headers: anna.headers, payload: { start_local: '2027-05-03T07:30' } });
    await t.idle();
    expect(t.airtrail.count('PUT')).toBe(1);
    expect([...t.airtrail.flights.values()][0]!.departure).toBe('2027-05-03T07:30:00+02:00');
  });

  it('recreates after a 404 (flight deleted in AirTrail)', async () => {
    t.airtrail.flights.clear();
    await t.app.inject({ method: 'PATCH', url: `/api/segments/${flightId}`, headers: anna.headers, payload: { seat: '8A' } });
    await t.idle();
    expect(t.airtrail.flights.size).toBe(1);
    const [newId] = [...t.airtrail.flights.keys()];
    expect(ids()[anna.id]).toBe(newId);
  });

  it('creates a flight for a traveler who joins (and syncs their old flights on key setup)', async () => {
    await t.app.inject({ method: 'PATCH', url: `/api/trips/${tripId}`, headers: anna.headers, payload: { traveler_ids: [anna.id, ben.id] } });
    await t.idle();
    expect(t.airtrail.flights.size).toBe(1); // Ben has no key yet
    await t.app.inject({ method: 'PUT', url: '/api/me/airtrail', headers: ben.headers, payload: { key: 'key-ben' } });
    await t.idle();
    expect(t.airtrail.flights.size).toBe(2);
    expect(Object.keys(ids()).sort()).toEqual([anna.id, ben.id].sort());
    // One seat field, two travelers: no seat guessing.
    const bens = [...t.airtrail.flights.values()].find((f) => f.owner === 'at-ben')!;
    expect(bens.passengers).toEqual([{ userId: 'at-ben' }]);
  });

  it('deletes when a traveler is removed', async () => {
    await t.app.inject({ method: 'PATCH', url: `/api/trips/${tripId}`, headers: anna.headers, payload: { traveler_ids: [anna.id] } });
    await t.idle();
    expect([...t.airtrail.flights.values()].map((f) => f.owner)).toEqual(['at-anna']);
    expect(Object.keys(ids())).toEqual([anna.id]);
  });

  it('deletes when the type changes away from flight', async () => {
    await t.app.inject({ method: 'PATCH', url: `/api/segments/${flightId}`, headers: anna.headers, payload: { type: 'train', number: 'ICE 1' } });
    await t.idle();
    expect(t.airtrail.flights.size).toBe(0);
    expect(ids()).toEqual({});
  });

  it('deletes with the segment and with the trip', async () => {
    await t.app.inject({ method: 'PATCH', url: `/api/segments/${flightId}`, headers: anna.headers, payload: { type: 'flight', number: 'LH 2010' } });
    await t.idle();
    expect(t.airtrail.flights.size).toBe(1);
    await t.app.inject({ method: 'DELETE', url: `/api/segments/${flightId}`, headers: anna.headers });
    await t.idle();
    expect(t.airtrail.flights.size).toBe(0);
  });

  it('shows errors at the segment instead of failing the request', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/trips/${tripId}/segments`, headers: anna.headers, payload: { ...flight, to_code: 'XXX' } });
    expect(res.statusCode).toBe(201);
    await t.idle();
    const s = (await t.app.inject({ method: 'GET', url: `/api/trips/${tripId}`, headers: anna.headers }))
      .json()
      .segments.find((x: { id: string }) => x.id === res.json().id);
    expect(s.airtrail.error).toContain('Flughafen XXX ist AirTrail unbekannt');
    await t.app.inject({ method: 'DELETE', url: `/api/segments/${res.json().id}`, headers: anna.headers });
  });

  it('runs for add_segment via MCP too', async () => {
    const before = t.airtrail.count('POST');
    const { token } = (await t.app.inject({ method: 'POST', url: '/api/tokens', headers: anna.headers, payload: { name: 'Claude' } })).json();
    const client = await t.mcp(token);
    const r = await client.callTool({
      name: 'add_segment',
      arguments: { trip_id: tripId, ...flight, from_code: 'JFK', start_tz: 'America/New_York', end_tz: 'America/New_York' },
    });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('LH 2010 JFK → MUC');
    await client.close();
    await t.idle();
    expect(t.airtrail.count('POST')).toBe(before + 1);
    const f = [...t.airtrail.flights.values()].at(-1)!;
    expect(f).toMatchObject({ fromId: 3, departure: '2027-05-03T07:00:00-04:00' });
  });
});

describe('AirTrail duplicate protection', () => {
  let d: TestApp;
  let anna: Awaited<ReturnType<TestApp['login']>>;
  let ben: Awaited<ReturnType<TestApp['login']>>;
  let tripId: string;
  const leg = { ...flight, start_local: '2027-06-01T07:00', end_local: '2027-06-01T08:10' };

  beforeAll(async () => {
    d = await createTestApp();
    anna = await d.login('Anna');
    ben = await d.login('Ben');
    await d.app.inject({ method: 'PUT', url: '/api/me/airtrail', headers: anna.headers, payload: { key: 'key-anna' } });
    await d.app.inject({ method: 'PUT', url: '/api/me/airtrail', headers: ben.headers, payload: { key: 'key-ben' } });
    tripId = (await d.app.inject({ method: 'POST', url: '/api/trips', headers: anna.headers, payload: { title: 'Doppelt?' } })).json().id;
    await d.idle();
  });
  afterAll(async () => d?.close());

  const segIds = (id: string) => JSON.parse(d.services.trips.rawSegment(id)!.airtrail_ids) as Record<string, string>;

  it('links a flight that is already in AirTrail instead of creating a second one, and keeps what AirTrail knows', async () => {
    // Entered by hand in AirTrail before: with aircraft, gate, a guest and an own note.
    const manual = d.airtrail.addManual('at-anna', {
      date: '2027-06-01',
      datePrecision: 'day',
      fromId: 1,
      toId: 2,
      flightNumber: 'LH2010',
      aircraftReg: 'D-AIZA',
      departureGate: 'B12',
      note: 'Fensterplatz!',
      passengers: [
        { userId: 'at-anna', seatNumber: '1A' },
        { userId: null, guestName: 'Oma' },
      ],
    });
    const posts = d.airtrail.count('POST');
    const id = (await d.app.inject({ method: 'POST', url: `/api/trips/${tripId}/segments`, headers: anna.headers, payload: { ...leg, seat: null } })).json().id;
    await d.idle();
    expect(d.airtrail.count('POST')).toBe(posts);
    expect(segIds(id)).toEqual({ [anna.id]: manual });
    const f = d.airtrail.flights.get(manual)!;
    expect(f).toMatchObject({ aircraftReg: 'D-AIZA', departureGate: 'B12', note: 'Fensterplatz!', departure: '2027-06-01T07:00:00+02:00', airlineId: 10 });
    // Own seat kept (Trips had none), the guest stays on the flight.
    expect(f.passengers).toEqual([
      expect.objectContaining({ userId: 'at-anna', seatNumber: '1A' }),
      expect.objectContaining({ userId: null, guestName: 'Oma' }),
    ]);
    await d.app.inject({ method: 'DELETE', url: `/api/segments/${id}`, headers: anna.headers });
    await d.idle();
  });

  it('creates a new flight when the flight number or the day differs, and never links one flight twice', async () => {
    const other = d.airtrail.addManual('at-anna', { date: '2027-06-02', fromId: 1, toId: 2, flightNumber: 'LH2010', passengers: [{ userId: 'at-anna' }] });
    const before = d.airtrail.count('POST');
    const a = (
      await d.app.inject({ method: 'POST', url: `/api/trips/${tripId}/segments`, headers: anna.headers, payload: { ...leg, number: 'LH 2012' } })
    ).json().id;
    const b = (
      await d.app.inject({ method: 'POST', url: `/api/trips/${tripId}/segments`, headers: anna.headers, payload: { ...leg, number: 'LH 2012' } })
    ).json().id;
    await d.idle();
    expect(d.airtrail.count('POST')).toBe(before + 2);
    expect(segIds(a)[anna.id]).not.toBe(segIds(b)[anna.id]);
    expect([segIds(a)[anna.id], segIds(b)[anna.id]]).not.toContain(other);
  });

  it('only unlinks a flight that another traveler shares', async () => {
    // One AirTrail flight with both as passengers – both get linked to it.
    const shared = d.airtrail.addManual('at-anna', {
      date: '2027-06-05',
      fromId: 2,
      toId: 1,
      flightNumber: 'LH2011',
      passengers: [{ userId: 'at-anna' }, { userId: 'at-ben' }],
    });
    await d.app.inject({ method: 'PATCH', url: `/api/trips/${tripId}`, headers: anna.headers, payload: { traveler_ids: [anna.id, ben.id] } });
    const id = (
      await d.app.inject({
        method: 'POST',
        url: `/api/trips/${tripId}/segments`,
        headers: anna.headers,
        payload: { ...leg, number: 'LH 2011', from_code: 'MUC', to_code: 'DUS', start_local: '2027-06-05T09:00', end_local: '2027-06-05T10:10' },
      })
    ).json().id;
    await d.idle();
    expect(segIds(id)).toEqual({ [anna.id]: shared, [ben.id]: shared });
    await d.app.inject({ method: 'PATCH', url: `/api/trips/${tripId}`, headers: anna.headers, payload: { traveler_ids: [anna.id] } });
    await d.idle();
    expect(d.airtrail.flights.has(shared)).toBe(true);
    expect(segIds(id)).toEqual({ [anna.id]: shared });
  });

  it('does not duplicate flights on import when they are already in AirTrail', async () => {
    const admin = await d.login('Chef', { admin: true, email: 'chef@example.org' });
    d.airtrail.users['key-chef'] = { id: 'at-chef', username: 'chef' };
    await d.app.inject({ method: 'PUT', url: '/api/me/airtrail', headers: admin.headers, payload: { key: 'key-chef' } });
    // Five flights the user already has in AirTrail (more than one page).
    for (let day = 10; day < 15; day++)
      d.airtrail.addManual('at-chef', { date: `2027-07-${day}`, fromId: 1, toId: 2, flightNumber: `LH${day}`, passengers: [{ userId: 'at-chef' }] });
    const data = {
      format: 'trips-export',
      version: 1,
      trips: [10, 11, 12, 13, 14, 15].map((day) => ({
        title: `Tag ${day}`,
        start_date: `2027-07-${day}`,
        end_date: `2027-07-${day}`,
        segments: [
          { type: 'flight', number: `LH ${day}`, from_code: 'DUS', to_code: 'MUC', start_local: `2027-07-${day}T07:00`, end_local: `2027-07-${day}T08:00` },
        ],
      })),
    };
    const before = d.airtrail.count('POST');
    await d.app.inject({ method: 'POST', url: '/api/admin/import', headers: admin.headers, payload: data });
    await d.idle();
    expect(d.airtrail.count('POST')).toBe(before + 1); // only day 15 is new
    expect([...d.airtrail.flights.values()].filter((f) => f.owner === 'at-chef')).toHaveLength(6);
  });
});
