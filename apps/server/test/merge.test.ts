import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, textOf } from './helpers.js';

let t: TestApp;
let anna: Awaited<ReturnType<TestApp['login']>>;
let ben: Awaited<ReturnType<TestApp['login']>>;

const post = (url: string, who: { headers: Record<string, string> }, payload: unknown) =>
  t.app.inject({ method: 'POST', url, headers: who.headers, payload: payload as object });
const get = async (url: string, who: { headers: Record<string, string> }) => t.app.inject({ method: 'GET', url, headers: who.headers });

async function upload(tripId: string, segmentId: string, name: string, content: string) {
  const body = `--b\r\nContent-Disposition: form-data; name="segment_id"\r\n\r\n${segmentId}\r\n--b\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\n% ${content}\n\r\n--b--\r\n`;
  const res = await t.app.inject({
    method: 'POST',
    url: `/api/trips/${tripId}/attachments`,
    headers: { ...anna.headers, 'content-type': 'multipart/form-data; boundary=b' },
    payload: body,
  });
  expect(res.statusCode).toBe(201);
}

beforeAll(async () => {
  t = await createTestApp();
  anna = await t.login('Anna');
  ben = await t.login('Ben');
  await t.app.inject({ method: 'PUT', url: '/api/me/airtrail', headers: anna.headers, payload: { key: 'key-anna' } });
  await t.app.inject({ method: 'PUT', url: '/api/me/airtrail', headers: ben.headers, payload: { key: 'key-ben' } });
});
afterAll(async () => t?.close());

describe('merging trips', () => {
  it('moves segments, attachments and travelers into the target and deletes the source', async () => {
    // TripIt split one holiday in two: the flight out and the hotel in one, the way back in another.
    const target = (
      await post('/api/trips', anna, { title: 'Mallorca', destination: null, start_date: '2027-07-04', end_date: '2027-07-10', notes: 'Finca' })
    ).json();
    const hin = (
      await post(`/api/trips/${target.id}/segments`, anna, {
        type: 'flight',
        number: 'EW 9580',
        from_code: 'DUS',
        to_code: 'PMI',
        start_local: '2027-07-04T07:10',
      })
    ).json();
    const source = (
      await post('/api/trips', ben, {
        title: 'Palma, Juli 2027',
        destination: 'Palma',
        start_date: '2027-07-14',
        end_date: '2027-07-14',
        notes: 'Mietwagen am Terminal',
        traveler_ids: [anna.id, ben.id],
      })
    ).json();
    const back = (
      await post(`/api/trips/${source.id}/segments`, ben, {
        type: 'flight',
        number: 'EW 9581',
        from_code: 'PMI',
        to_code: 'DUS',
        start_local: '2027-07-14T10:15',
      })
    ).json();
    await upload(target.id, hin.id, 'E-Ticket.pdf', 'ticket');
    await upload(source.id, back.id, 'E-Ticket.pdf', 'ticket'); // same file in both trips
    await upload(source.id, back.id, 'Mietwagen.pdf', 'car');
    await t.idle();

    // Ben may not edit "Mallorca" (Anna's trip): not allowed.
    expect((await post(`/api/trips/${source.id}/merge`, ben, { into: target.id })).statusCode).toBe(403);
    expect((await post(`/api/trips/${target.id}/merge`, anna, { into: target.id })).statusCode).toBe(400);

    const res = await post(`/api/trips/${source.id}/merge`, anna, { into: target.id });
    expect(res.statusCode).toBe(200);
    const merged = res.json();
    expect(merged).toMatchObject({
      id: target.id,
      title: 'Mallorca',
      destination: 'Palma',
      start_date: '2027-07-04',
      end_date: '2027-07-14',
      notes: 'Finca\n\nPalma, Juli 2027: Mietwagen am Terminal',
    });
    expect(merged.travelers.map((u: { name: string }) => u.name)).toEqual(['Anna', 'Ben']);
    expect(merged.segments.map((s: { number: string }) => s.number)).toEqual(['EW 9580', 'EW 9581']);
    // The e-ticket exists once, linked to both flights.
    const files = Object.fromEntries(merged.attachments.map((a: { filename: string; segment_ids: string[] }) => [a.filename, a.segment_ids.length]));
    expect(files).toEqual({ 'E-Ticket.pdf': 2, 'Mietwagen.pdf': 1 });
    expect((await get(`/api/trips/${source.id}`, anna)).statusCode).toBe(404);
    // The file of the removed duplicate is gone, the kept ones can be downloaded.
    for (const a of merged.attachments) expect((await get(a.url, anna)).statusCode).toBe(200);

    // AirTrail: Ben joined Anna's outbound flight – he gets it in his AirTrail too.
    await t.idle();
    const owners = [...t.airtrail.flights.values()].map((f) => `${f.owner}:${f.flightNumber}`).sort();
    expect(owners).toEqual(['at-anna:EW9580', 'at-anna:EW9581', 'at-ben:EW9580', 'at-ben:EW9581']);
  });

  it('is available as MCP tool', async () => {
    const a = (await post('/api/trips', anna, { title: 'Teil 1', start_date: '2027-09-01' })).json();
    const b = (await post('/api/trips', anna, { title: 'Teil 2', start_date: '2027-09-03' })).json();
    const { token } = (await post('/api/tokens', anna, { name: 'Claude' })).json();
    const client = await t.mcp(token);
    const r = await client.callTool({ name: 'merge_trips', arguments: { source_trip_id: b.id, target_trip_id: a.id } });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('„Teil 2“ ist jetzt Teil von „Teil 1“');
    await client.close();
    expect((await get(`/api/trips/${a.id}`, anna)).json()).toMatchObject({ start_date: '2027-09-01', end_date: '2027-09-03' });
  });
});
