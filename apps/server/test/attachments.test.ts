import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import type { Extraction } from '../src/extract/claude.js';
import { createTestApp, seg, type TestApp } from './helpers.js';

let t: TestApp;
let anna: Awaited<ReturnType<TestApp['login']>>;

/** A mail with two PDFs: the e-ticket for both flights and the hotel voucher. */
function mailWithPdfs(id: string): string {
  const pdf = (label: string) => Buffer.from(`%PDF-1.4\n% ${label}\n`).toString('base64');
  return [
    'From: anna@example.org',
    'To: trips@example.org',
    'Subject: Ihre Reise nach Lissabon',
    `Message-ID: <${id}>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Buchung anbei.',
    '--b1',
    'Content-Type: application/pdf; name="E-Ticket.pdf"',
    'Content-Disposition: attachment; filename="E-Ticket.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    pdf('ticket'),
    '--b1',
    'Content-Type: application/pdf; name="Hotelgutschein.pdf"',
    'Content-Disposition: attachment; filename="Hotelgutschein.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    pdf('voucher'),
    '--b1--',
    '',
  ].join('\r\n');
}

const booking = (withDocs: boolean): Extraction => ({
  is_booking: true,
  trip_title: 'Lissabon',
  destination: 'Lissabon',
  passengers: [],
  segments: [
    seg({ type: 'flight', number: 'TP 575', from_code: 'DUS', to_code: 'LIS', start_local: '2027-06-10T08:00', documents: withDocs ? ['E-Ticket.pdf'] : [] }),
    seg({ type: 'flight', number: 'TP 576', from_code: 'LIS', to_code: 'DUS', start_local: '2027-06-14T19:00', documents: withDocs ? ['e-ticket'] : [] }),
    seg({ type: 'hotel', title: 'Casa Azul', start_local: '2027-06-10', end_local: '2027-06-14', documents: withDocs ? ['Hotelgutschein.pdf'] : [] }),
  ],
});

beforeAll(async () => {
  t = await createTestApp();
  anna = await t.login('Anna');
});
afterAll(async () => t?.close());

const tripOf = async (id: string) => (await t.app.inject({ method: 'GET', url: `/api/trips/${id}`, headers: anna.headers })).json();
const linksBy = (trip: { segments: { id: string; title: string }[]; attachments: { filename: string; segment_ids: string[] }[] }) =>
  Object.fromEntries(trip.attachments.map((a) => [a.filename, a.segment_ids.map((id) => trip.segments.find((s) => s.id === id)!.title).sort()]));

describe('attachments belong to the segments they came with', () => {
  it('puts each PDF on the segments Claude found in it', async () => {
    t.setExtraction(booking(true));
    await t.services.mail.process(mailWithPdfs('pdfs-1@example.org'));
    const [summary] = (await t.app.inject({ method: 'GET', url: '/api/trips?q=lissabon', headers: anna.headers })).json();
    expect(linksBy(await tripOf(summary.id))).toEqual({
      'E-Ticket.pdf': ['TP 575 DUS → LIS', 'TP 576 LIS → DUS'],
      'Hotelgutschein.pdf': ['Casa Azul'],
    });
    await t.app.inject({ method: 'DELETE', url: `/api/trips/${summary.id}`, headers: anna.headers });
  });

  it('without a hint, puts the PDFs on all segments of that booking – never on the whole trip', async () => {
    t.setExtraction(booking(false));
    await t.services.mail.process(mailWithPdfs('pdfs-2@example.org'));
    const [summary] = (await t.app.inject({ method: 'GET', url: '/api/trips?q=lissabon', headers: anna.headers })).json();
    const all = ['Casa Azul', 'TP 575 DUS → LIS', 'TP 576 LIS → DUS'];
    expect(linksBy(await tripOf(summary.id))).toEqual({ 'E-Ticket.pdf': all, 'Hotelgutschein.pdf': all });
  });

  it('copies a shared PDF when only one of its segments moves', async () => {
    const [summary] = (await t.app.inject({ method: 'GET', url: '/api/trips?q=lissabon', headers: anna.headers })).json();
    const trip = await tripOf(summary.id);
    const ret = trip.segments.find((s: { title: string }) => s.title.startsWith('TP 576'));
    const moved = (
      await t.app.inject({ method: 'POST', url: `/api/segments/${ret.id}/move`, headers: anna.headers, payload: { new_trip_title: 'Rückflug' } })
    ).json();
    expect(linksBy(moved.trip)).toEqual({ 'E-Ticket.pdf': ['TP 576 LIS → DUS'], 'Hotelgutschein.pdf': ['TP 576 LIS → DUS'] });
    // The old trip keeps its files for the remaining segments.
    expect(linksBy(await tripOf(summary.id))).toEqual({
      'E-Ticket.pdf': ['Casa Azul', 'TP 575 DUS → LIS'],
      'Hotelgutschein.pdf': ['Casa Azul', 'TP 575 DUS → LIS'],
    });
  });

  it('can attach a file to one segment by hand', async () => {
    const [summary] = (await t.app.inject({ method: 'GET', url: '/api/trips?q=lissabon', headers: anna.headers })).json();
    const trip = await tripOf(summary.id);
    const hotel = trip.segments.find((s: { title: string }) => s.title === 'Casa Azul');
    const body = `--b\r\nContent-Disposition: form-data; name="segment_id"\r\n\r\n${hotel.id}\r\n--b\r\nContent-Disposition: form-data; name="file"; filename="Rechnung.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\n% bill\n\r\n--b--\r\n`;
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/trips/${trip.id}/attachments`,
      headers: { ...anna.headers, 'content-type': 'multipart/form-data; boundary=b' },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    expect(linksBy(await tripOf(trip.id))['Rechnung.pdf']).toEqual(['Casa Azul']);
  });
});

describe('migration of existing attachments', () => {
  it('links trip-wide attachments to the segments of the same import', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trips-mig-'));
    const file = join(dir, 'trips.db');
    const old = new DatabaseSync(file);
    old.exec(MIGRATIONS[0]!);
    old.exec(`
      INSERT INTO users (id, sub, name, ics_nonce) VALUES ('u1', 'sub1', 'Anna', 'n');
      INSERT INTO trips (id, title) VALUES ('t1', 'Wien');
      INSERT INTO segments (id, trip_id, type, title, created_at, updated_at) VALUES
        ('s1', 't1', 'flight', 'Hin', '2026-11-18T10:22:01.000Z', '2026-11-18T10:22:01.000Z'),
        ('s2', 't1', 'flight', 'Rück', '2026-11-18T10:22:02.000Z', '2026-11-18T10:22:02.000Z'),
        ('s3', 't1', 'hotel', 'Später von Hand', '2026-11-19T08:00:00.000Z', '2026-11-19T08:00:00.000Z');
      INSERT INTO attachments (id, trip_id, segment_id, filename, mime, size, sha256, created_at) VALUES
        ('a1', 't1', NULL, 'Ticket.pdf', 'application/pdf', 1, 'x', '2026-11-18T10:22:03.000Z'),
        ('a2', 't1', 's3', 'Hotel.pdf', 'application/pdf', 1, 'y', '2026-11-19T09:00:00.000Z'),
        ('a3', 't1', NULL, 'Sonstiges.pdf', 'application/pdf', 1, 'z', '2026-11-25T12:00:00.000Z');
      PRAGMA user_version = 1;
    `);
    old.close();
    const db = new Db(file);
    const links = db.all<{ attachment_id: string; segment_id: string }>('SELECT * FROM attachment_segments ORDER BY attachment_id, segment_id');
    expect(links).toEqual([
      { attachment_id: 'a1', segment_id: 's1' },
      { attachment_id: 'a1', segment_id: 's2' },
      { attachment_id: 'a2', segment_id: 's3' },
    ]);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
