import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, textOf } from './helpers.js';

let t: TestApp;
let anna: Awaited<ReturnType<TestApp['login']>>;
let ben: Awaited<ReturnType<TestApp['login']>>;
let admin: Awaited<ReturnType<TestApp['login']>>;
let tripId: string;
let segmentId: string;

beforeAll(async () => {
  t = await createTestApp();
  anna = await t.login('Anna');
  ben = await t.login('Ben');
  admin = await t.login('Chef', { admin: true });
  const trip = await t.app.inject({ method: 'POST', url: '/api/trips', headers: anna.headers, payload: { title: 'Lissabon', start_date: '2026-12-01', end_date: '2026-12-05' } });
  expect(trip.statusCode).toBe(201);
  tripId = trip.json().id;
  const s = await t.app.inject({
    method: 'POST',
    url: `/api/trips/${tripId}/segments`,
    headers: anna.headers,
    payload: { type: 'hotel', title: 'Casa Azul', start_local: '2026-12-01T15:00', start_tz: 'Europe/Lisbon', end_local: '2026-12-05T11:00', end_tz: 'Europe/Lisbon' },
  });
  expect(s.statusCode).toBe(201);
  segmentId = s.json().id;
});
afterAll(async () => t?.close());

describe('REST permissions', () => {
  it('requires a login', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/trips' });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toContain('anmelden');
  });

  it('lets every signed-in user read every trip', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/api/trips/${tripId}`, headers: ben.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ title: 'Lissabon', can_edit: false });
    const list = await t.app.inject({ method: 'GET', url: '/api/trips', headers: ben.headers });
    expect(list.json().map((x: { id: string }) => x.id)).toContain(tripId);
    const mine = await t.app.inject({ method: 'GET', url: '/api/trips?mine=true', headers: ben.headers });
    expect(mine.json()).toEqual([]);
  });

  it('forbids changes by a reader', async () => {
    const patch = await t.app.inject({ method: 'PATCH', url: `/api/trips/${tripId}`, headers: ben.headers, payload: { title: 'Gekapert' } });
    expect(patch.statusCode).toBe(403);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/trips/${tripId}`, headers: ben.headers })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'POST', url: `/api/trips/${tripId}/segments`, headers: ben.headers, payload: { type: 'other', title: 'x' } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'PATCH', url: `/api/segments/${segmentId}`, headers: ben.headers, payload: { title: 'x' } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/segments/${segmentId}`, headers: ben.headers })).statusCode).toBe(403);
    // Adding yourself as traveler is a change too.
    const self = await t.app.inject({ method: 'PATCH', url: `/api/trips/${tripId}`, headers: ben.headers, payload: { traveler_ids: [anna.id, ben.id] } });
    expect(self.statusCode).toBe(403);
  });

  it('lets travelers and admins change', async () => {
    const byAnna = await t.app.inject({ method: 'PATCH', url: `/api/trips/${tripId}`, headers: anna.headers, payload: { traveler_ids: [anna.id, ben.id] } });
    expect(byAnna.statusCode).toBe(200);
    expect(byAnna.json().travelers.map((u: { name: string }) => u.name)).toEqual(['Anna', 'Ben']);
    const byBen = await t.app.inject({ method: 'PATCH', url: `/api/segments/${segmentId}`, headers: ben.headers, payload: { seat: 'Zimmer 12' } });
    expect(byBen.statusCode).toBe(200);
    const byAdmin = await t.app.inject({ method: 'PATCH', url: `/api/trips/${tripId}`, headers: admin.headers, payload: { notes: 'vom Admin' } });
    expect(byAdmin.statusCode).toBe(200);
    expect(byAdmin.json().can_edit).toBe(true);
    // Back to Anna alone.
    await t.app.inject({ method: 'PATCH', url: `/api/trips/${tripId}`, headers: anna.headers, payload: { traveler_ids: [anna.id] } });
  });

  it('keeps admin functions for admins', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/mail-log', headers: anna.headers })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/mail-log', headers: admin.headers })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'POST', url: '/api/admin/import', headers: anna.headers, payload: {} })).statusCode).toBe(403);
  });

  it('extends trip dates to cover all segments', async () => {
    const s = await t.app.inject({
      method: 'POST',
      url: `/api/trips/${tripId}/segments`,
      headers: anna.headers,
      payload: { type: 'parking', carrier: 'Holiday Parking DUS P7', start_local: '2026-11-30T05:30', start_tz: 'Europe/Berlin', end_local: '2026-12-06T22:00', end_tz: 'Europe/Berlin' },
    });
    expect(s.json().title).toBe('Holiday Parking DUS P7');
    const trip = (await t.app.inject({ method: 'GET', url: `/api/trips/${tripId}`, headers: anna.headers })).json();
    expect(trip).toMatchObject({ start_date: '2026-11-30', end_date: '2026-12-06' });
  });

  it('validates input in German', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/trips/${tripId}/segments`, headers: anna.headers, payload: { type: 'flight', start_local: '1.12.2026' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('YYYY-MM-DD');
  });
});

describe('API tokens and MCP use the same rights', () => {
  it('creates, uses and revokes a personal token', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/api/tokens', headers: ben.headers, payload: { name: 'Skript' } });
    expect(created.statusCode).toBe(200);
    const { token, id } = created.json();
    expect(token).toMatch(/^trp_/);
    const auth = { authorization: `Bearer ${token}` };

    expect((await t.app.inject({ method: 'GET', url: `/api/trips/${tripId}`, headers: auth })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'PATCH', url: `/api/trips/${tripId}`, headers: auth, payload: { title: 'x' } })).statusCode).toBe(403);
    // Tokens can't manage tokens.
    expect((await t.app.inject({ method: 'GET', url: '/api/tokens', headers: auth })).statusCode).toBe(403);

    const client = await t.mcp(token);
    const read = await client.callTool({ name: 'get_trip', arguments: { trip_id: tripId } });
    expect(textOf(read)).toContain('# Lissabon');
    expect(textOf(read)).toContain('Darfst du ändern: nein');
    const write = await client.callTool({ name: 'update_trip', arguments: { trip_id: tripId, title: 'Gekapert' } });
    expect(write.isError).toBe(true);
    expect(textOf(write)).toContain('Berechtigung');
    const del = await client.callTool({ name: 'delete_segment', arguments: { segment_id: segmentId } });
    expect(del.isError).toBe(true);
    await client.close();

    const list = (await t.app.inject({ method: 'GET', url: '/api/tokens', headers: ben.headers })).json();
    expect(list.find((x: { id: string }) => x.id === id)).toMatchObject({ name: 'Skript', kind: 'pat' });
    expect((await t.app.inject({ method: 'DELETE', url: `/api/tokens/${id}`, headers: ben.headers })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: `/api/trips/${tripId}`, headers: auth })).statusCode).toBe(401);
  });

  it('lets the traveler change via MCP, and the admin too', async () => {
    const { token } = (await t.app.inject({ method: 'POST', url: '/api/tokens', headers: anna.headers, payload: { name: 'Claude Desktop' } })).json();
    const client = await t.mcp(token);
    const tools = (await client.listTools()).tools.map((x) => x.name);
    expect(tools).toEqual(
      expect.arrayContaining([
        'list_trips',
        'get_trip',
        'create_trip',
        'update_trip',
        'delete_trip',
        'add_segment',
        'update_segment',
        'delete_segment',
        'find_trip_for_date',
        'import_booking_text',
        'list_users',
        'get_attachment_info',
      ]),
    );
    const ok = await client.callTool({ name: 'update_segment', arguments: { segment_id: segmentId, seat: '301' } });
    expect(ok.isError).toBeFalsy();
    const bad = await client.callTool({ name: 'add_segment', arguments: { trip_id: tripId, type: 'flight', start_local: 'morgen' } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('YYYY-MM-DD');
    const users = await client.callTool({ name: 'list_users', arguments: {} });
    expect(textOf(users)).toContain('Anna (du)');
    const found = await client.callTool({ name: 'find_trip_for_date', arguments: { start_date: '2026-12-09' } });
    expect(textOf(found)).toContain(tripId);
    const res = await client.readResource({ uri: 'trips://upcoming' });
    expect(JSON.stringify(res.contents)).toContain('Lissabon');
    await client.close();

    const adminToken = (await t.app.inject({ method: 'POST', url: '/api/tokens', headers: admin.headers, payload: { name: 'Admin' } })).json().token;
    const ac = await t.mcp(adminToken);
    const adminWrite = await ac.callTool({ name: 'update_trip', arguments: { trip_id: tripId, notes: 'Admin war hier' } });
    expect(adminWrite.isError).toBeFalsy();
    await ac.close();
  });
});
