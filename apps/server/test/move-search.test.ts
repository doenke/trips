import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, textOf } from './helpers.js';

let t: TestApp;
let anna: Awaited<ReturnType<TestApp['login']>>;
let ben: Awaited<ReturnType<TestApp['login']>>;
let business: string;
let flightId: string;

const post = (url: string, who: { headers: Record<string, string> }, payload: unknown) =>
  t.app.inject({ method: 'POST', url, headers: who.headers, payload: payload as object });
const get = async (url: string, who: { headers: Record<string, string> }) => (await t.app.inject({ method: 'GET', url, headers: who.headers })).json();

beforeAll(async () => {
  t = await createTestApp();
  anna = await t.login('Anna');
  ben = await t.login('Ben');
  // A business trip in Vienna; the import put a private weekend flight into it by the ±5 days rule.
  business = (
    await post('/api/trips', anna, {
      title: 'Messe Wien',
      destination: 'Wien',
      start_date: '2026-11-17',
      end_date: '2026-11-19',
      traveler_ids: [anna.id, ben.id],
    })
  ).json().id;
  await post(`/api/trips/${business}/segments`, anna, { type: 'hotel', title: 'Hotel Sissi', start_local: '2026-11-17', end_local: '2026-11-19' });
  flightId = (
    await post(`/api/trips/${business}/segments`, anna, {
      type: 'flight',
      number: 'EW 9754',
      from_code: 'DUS',
      to_code: 'VIE',
      start_local: '2026-11-23T16:50',
      end_local: '2026-11-23T18:25',
      booking_ref: 'K7PQ2Z',
    })
  ).json().id;
});
afterAll(async () => t?.close());

describe('moving a segment', () => {
  it('moves into a new trip with the same travelers and shrinks the old trip back', async () => {
    expect((await get(`/api/trips/${business}`, anna)).end_date).toBe('2026-11-23');
    const res = await post(`/api/segments/${flightId}/move`, anna, { new_trip_title: 'Wochenende in Wien' });
    expect(res.statusCode).toBe(200);
    const target = res.json().trip;
    expect(target).toMatchObject({ title: 'Wochenende in Wien', start_date: '2026-11-23', end_date: '2026-11-23' });
    expect(target.travelers.map((u: { name: string }) => u.name)).toEqual(['Anna', 'Ben']);
    expect(target.segments.map((s: { id: string }) => s.id)).toEqual([flightId]);
    const old = await get(`/api/trips/${business}`, anna);
    expect(old).toMatchObject({ start_date: '2026-11-17', end_date: '2026-11-19' });
    expect(old.segments).toHaveLength(1);
  });

  it('moves into an existing trip, takes its attachments along, and checks rights on both sides', async () => {
    const other = (await post('/api/trips', anna, { title: 'Wien privat', start_date: '2026-11-22', end_date: '2026-11-24' })).json().id;
    const current = (await get(`/api/trips?q=EW 9754`, anna))[0].id;
    // Attach a PDF to the flight first.
    const boundary = 'b';
    const pdf = '%PDF-1.4\n% boarding pass\n';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="segment_id"\r\n\r\n${flightId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Bordkarte.pdf"\r\nContent-Type: application/pdf\r\n\r\n${pdf}\r\n--${boundary}--\r\n`;
    const att = await t.app.inject({
      method: 'POST',
      url: `/api/trips/${current}/attachments`,
      headers: { ...anna.headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(att.statusCode).toBe(201);

    // Ben travels on the source trip but not on "Wien privat": not allowed there.
    const denied = await post(`/api/segments/${flightId}/move`, ben, { trip_id: other });
    expect(denied.statusCode).toBe(403);

    const ok = await post(`/api/segments/${flightId}/move`, anna, { trip_id: other });
    expect(ok.statusCode).toBe(200);
    const target = ok.json().trip;
    expect(target.segments.map((s: { id: string }) => s.id)).toEqual([flightId]);
    expect(target.attachments.map((a: { filename: string; segment_id: string }) => [a.filename, a.segment_id])).toEqual([['Bordkarte.pdf', flightId]]);
    expect((await get(`/api/trips/${current}`, anna)).attachments).toEqual([]);

    const same = await post(`/api/segments/${flightId}/move`, anna, { trip_id: other });
    expect(same.statusCode).toBe(400);
    const neither = await post(`/api/segments/${flightId}/move`, anna, {});
    expect(neither.statusCode).toBe(400);
  });

  it('is available as MCP tool', async () => {
    const { token } = (await post('/api/tokens', anna, { name: 'Claude' })).json();
    const client = await t.mcp(token);
    const r = await client.callTool({ name: 'move_segment', arguments: { segment_id: flightId, trip_id: business } });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('Verschoben nach „Messe Wien“');
    const found = await client.callTool({ name: 'list_trips', arguments: { query: 'k7pq2z' } });
    expect(textOf(found)).toContain('Messe Wien');
    await client.close();
  });
});

describe('search', () => {
  it('finds trips by title, places, numbers and booking refs, ignoring case and umlauts', async () => {
    await post('/api/trips', ben, { title: 'Düsseldorf Altstadt', start_date: '2025-05-01' });
    const titles = async (q: string) => (await get(`/api/trips?filter=all&q=${encodeURIComponent(q)}`, anna)).map((x: { title: string }) => x.title);
    expect(await titles('wien')).toEqual(expect.arrayContaining(['Messe Wien', 'Wochenende in Wien', 'Wien privat']));
    expect(await titles('sissi')).toEqual(['Messe Wien']);
    expect(await titles('ew9754')).toEqual(['Messe Wien']);
    expect(await titles('EW 9754')).toEqual(['Messe Wien']);
    expect(await titles('dusseldorf')).toEqual(['Düsseldorf Altstadt']);
    expect(await titles('Duesseldorf')).toEqual(['Düsseldorf Altstadt']);
    expect(await titles('wien messe')).toEqual(['Messe Wien']);
    expect(await titles('wien paris')).toEqual([]);
    // "Meine" still applies
    expect((await get(`/api/trips?mine=true&q=d%C3%BCsseldorf`, anna)).length).toBe(0);
  });
});
