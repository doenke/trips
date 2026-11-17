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
