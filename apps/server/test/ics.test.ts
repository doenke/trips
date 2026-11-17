import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildIcs, foldLine } from '../src/ics.js';
import { segmentView, type SegmentRow, type TripView } from '../src/service/trips.js';
import { createTestApp, type TestApp } from './helpers.js';

const base: Omit<SegmentRow, 'id' | 'type' | 'title'> = {
  trip_id: 't1',
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
  source: 'manual',
  airtrail_ids: '{}',
  airtrail_error: null,
  created_at: '',
  updated_at: '',
};

const trip: TripView = {
  id: 't1',
  title: 'New York, Messe',
  destination: 'New York',
  start_date: '2027-03-27',
  end_date: '2027-04-02',
  notes: null,
  created_by: null,
  created_at: '',
  updated_at: '',
  travelers: [],
  can_edit: true,
  attachments: [],
  segments: [
    segmentView({ ...base, id: 's1', type: 'flight', title: 'LH 400 FRA → JFK', number: 'LH 400', from_code: 'FRA', to_code: 'JFK', start_local: '2027-03-27T10:00', start_tz: 'Europe/Berlin', end_local: '2027-03-27T12:45', end_tz: 'America/New_York' }),
    segmentView({ ...base, id: 's2', type: 'hotel', title: 'Pod Hotel; Times Square', address: '400 W 42nd St, New York', start_local: '2027-03-27T15:00', start_tz: 'America/New_York', end_local: '2027-04-02T11:00', end_tz: 'America/New_York', booking_ref: 'H-77' }),
    segmentView({ ...base, id: 's3', type: 'parking', title: 'Holiday Parking FRA', address: 'Cargo City Süd, Frankfurt', start_local: '2027-03-27T07:00', start_tz: 'Europe/Berlin', end_local: '2027-04-03T09:00', end_tz: 'Europe/Berlin', seat: 'P3' }),
  ],
};

describe('ICS', () => {
  const ics = buildIcs([trip], { publicUrl: 'https://trips.example.org', now: new Date('2026-11-17T10:00:00Z') });
  const events = ics.split('BEGIN:VEVENT').slice(1).map((e) => e.replace(/\r\n /g, ''));
  const find = (summary: string) => events.find((e) => e.includes(`SUMMARY:${summary}`))!;

  it('has an all-day event per trip', () => {
    const e = find('🧳 New York\\, Messe');
    expect(e).toContain('DTSTART;VALUE=DATE:20270327');
    expect(e).toContain('DTEND;VALUE=DATE:20270403');
  });

  it('converts segment times to UTC (across zones and DST)', () => {
    const f = find('✈️ LH 400 FRA → JFK');
    // 10:00 CET (Berlin is still on winter time on 27 March 2027) = 09:00Z; 12:45 EDT = 16:45Z
    expect(f).toContain('DTSTART:20270327T090000Z');
    expect(f).toContain('DTEND:20270327T164500Z');
  });

  it('splits hotels into check-in and check-out', () => {
    const inEv = find('🏨 Check-in: Pod Hotel\\; Times Square');
    const outEv = find('🏨 Check-out: Pod Hotel\\; Times Square');
    expect(inEv).toContain('DTSTART:20270327T190000Z');
    expect(inEv).toContain('LOCATION:400 W 42nd St\\, New York');
    expect(outEv).toContain('DTSTART:20270402T150000Z');
    expect(outEv).toContain('Buchungsnummer: H-77');
  });

  it('splits parking into entry and exit with the address', () => {
    const entry = find('🅿️ Einfahrt: Holiday Parking FRA');
    const exit = find('🅿️ Ausfahrt: Holiday Parking FRA');
    expect(entry).toContain('DTSTART:20270327T060000Z');
    expect(entry).toContain('DTEND:20270327T061500Z');
    expect(entry).toContain('LOCATION:Cargo City Süd\\, Frankfurt');
    expect(exit).toContain('DTSTART:20270403T070000Z');
    expect(exit).toContain('Stellplatz: P3');
  });

  it('uses CRLF and folds long lines at 75 octets', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    const long = `DESCRIPTION:${'ä'.repeat(100)}`;
    const folded = foldLine(long);
    expect(folded.split('\r\n ').join('')).toBe(long);
    expect(folded.split('\r\n').every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
  });
});

describe('ICS feed endpoint', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t?.close());

  it('serves only the trips you travel on, and the link can be renewed', async () => {
    const anna = await t.login('Anna');
    const ben = await t.login('Ben');
    await t.app.inject({ method: 'POST', url: '/api/trips', headers: anna.headers, payload: { title: 'Annas Reise', start_date: '2027-01-01' } });
    await t.app.inject({ method: 'POST', url: '/api/trips', headers: ben.headers, payload: { title: 'Bens Reise', start_date: '2027-01-01' } });
    const me = (await t.app.inject({ method: 'GET', url: '/api/me', headers: anna.headers })).json();
    const path = new URL(me.ics_url).pathname;
    const feed = await t.app.inject({ method: 'GET', url: path });
    expect(feed.statusCode).toBe(200);
    expect(feed.headers['content-type']).toContain('text/calendar');
    expect(feed.body).toContain('Annas Reise');
    expect(feed.body).not.toContain('Bens Reise');
    expect((await t.app.inject({ method: 'GET', url: path.replace(/.{4}\.ics$/, 'xxxx.ics') })).statusCode).toBe(404);
    const rotated = (await t.app.inject({ method: 'POST', url: '/api/me/ics/rotate', headers: anna.headers })).json();
    expect(rotated.ics_url).not.toBe(me.ics_url);
    expect((await t.app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
  });
});

describe('health and export', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t?.close());

  it('reports ok with version, without login and without cache', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ status: 'ok', version: 'dev', checks: { db: 'ok', data: 'ok' } });
  });

  it('reports 503 when the database is gone', async () => {
    const t2 = await createTestApp();
    t2.services.db.close();
    const res = await t2.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'error', checks: { db: 'error' } });
    t2.services.db.close = () => undefined;
    await t2.close();
  });

  it('exports all readable trips and imports them back (admin)', async () => {
    const anna = await t.login('Anna');
    const admin = await t.login('Chef', { admin: true });
    const trip = (await t.app.inject({ method: 'POST', url: '/api/trips', headers: anna.headers, payload: { title: 'Rom', start_date: '2027-04-01', end_date: '2027-04-05' } })).json();
    await t.app.inject({ method: 'POST', url: `/api/trips/${trip.id}/segments`, headers: anna.headers, payload: { type: 'hotel', title: 'Hotel Roma', start_local: '2027-04-01', end_local: '2027-04-05' } });
    const exp = await t.app.inject({ method: 'GET', url: '/api/export', headers: admin.headers });
    expect(exp.headers['content-disposition']).toContain('trips-export-');
    const data = exp.json();
    expect(data).toMatchObject({ format: 'trips-export', version: 1, trips: [{ title: 'Rom', travelers: [{ name: 'Anna' }], segments: [{ type: 'hotel', title: 'Hotel Roma' }] }] });

    // Same file again: skipped. Renamed: imported for Anna.
    const again = (await t.app.inject({ method: 'POST', url: '/api/admin/import', headers: admin.headers, payload: data })).json();
    expect(again).toMatchObject({ created: [], skipped: ['Rom (2027-04-01)'] });
    data.trips[0].title = 'Rom (Kopie)';
    const imported = (await t.app.inject({ method: 'POST', url: '/api/admin/import', headers: admin.headers, payload: data })).json();
    expect(imported.created).toEqual([expect.objectContaining({ title: 'Rom (Kopie)', segments: 1 })]);
    const copy = (await t.app.inject({ method: 'GET', url: `/api/trips/${imported.created[0].id}`, headers: anna.headers })).json();
    expect(copy.can_edit).toBe(true);
    expect(copy.segments[0].source).toBe('import');
    const garbage = await t.app.inject({ method: 'POST', url: '/api/admin/import', headers: admin.headers, payload: { hello: 1 } });
    expect(garbage.statusCode).toBe(400);
  });
});
