import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Extraction } from '../src/extract/claude.js';
import { createTestApp, rawMail, seg, type TestApp } from './helpers.js';

let t: TestApp;
let soenke: Awaited<ReturnType<TestApp['login']>>;
let ulli: Awaited<ReturnType<TestApp['login']>>;

const flightBooking: Extraction = {
  is_booking: true,
  trip_title: 'Mallorca im Juli',
  destination: 'Palma',
  passengers: ['JACOBS/SOENKE MR', 'JACOBS/ULLI MRS'],
  segments: [
    seg({
      type: 'flight',
      number: 'EW 9580',
      from_code: 'DUS',
      to_code: 'PMI',
      start_local: '2027-07-04T07:10',
      start_tz: 'Europe/Berlin',
      end_local: '2027-07-04T09:30',
      end_tz: 'Europe/Madrid',
      booking_ref: 'X7Q2PL',
    }),
    seg({
      type: 'flight',
      number: 'EW 9581',
      from_code: 'PMI',
      to_code: 'DUS',
      start_local: '2027-07-14T10:15',
      start_tz: 'Europe/Madrid',
      end_local: '2027-07-14T12:40',
      end_tz: 'Europe/Berlin',
      booking_ref: 'X7Q2PL',
    }),
  ],
};

const parkingBooking: Extraction = {
  is_booking: true,
  trip_title: 'Parken DUS',
  destination: null,
  passengers: ['Sönke Jacobs'],
  segments: [
    seg({
      type: 'parking',
      title: 'Holiday Parking DUS P7',
      start_local: '2027-07-04T05:00',
      start_tz: 'Europe/Berlin',
      end_local: '2027-07-14T14:00',
      end_tz: 'Europe/Berlin',
      booking_ref: 'HP-4711',
      address: 'Flughafenstraße 120, 40474 Düsseldorf',
      notes: 'Kennzeichen D-SJ 123, Shuttle alle 15 Min.',
    }),
  ],
};

let n = 0;
const mail = (from: string, extra: Partial<Parameters<typeof rawMail>[0]> = {}) =>
  rawMail({ from, subject: 'Ihre Buchung', text: 'Buchungsbestätigung … (siehe Anhang)', messageId: `m${++n}@example.org`, ...extra });

beforeAll(async () => {
  t = await createTestApp({ env: { MAIL_REQUIRE_DMARC_PASS: 'true' } });
  soenke = await t.login('Sönke Jacobs', { email: 'soenke@example.org' });
  ulli = await t.login('Ulli Jacobs', { email: 'ulli@example.org' });
  await t.login('Fremder Mensch', { email: 'fremd@example.org' });
});
afterAll(async () => t?.close());

const tripsOf = async (who: { headers: Record<string, string> }) =>
  (await t.app.inject({ method: 'GET', url: '/api/trips?mine=true', headers: who.headers })).json();

describe('alternative sender addresses', () => {
  it('adds, refuses collisions and removes', async () => {
    const add = await t.app.inject({ method: 'POST', url: '/api/me/emails', headers: soenke.headers, payload: { email: 'Soenke@Work.example' } });
    expect(add.json().alt_emails).toEqual(['soenke@work.example']);
    const taken = await t.app.inject({ method: 'POST', url: '/api/me/emails', headers: ulli.headers, payload: { email: 'soenke@work.example' } });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().message).toContain('anderen Konto');
    const login = await t.app.inject({ method: 'POST', url: '/api/me/emails', headers: ulli.headers, payload: { email: 'soenke@example.org' } });
    expect(login.statusCode).toBe(409);
    const own = await t.app.inject({ method: 'POST', url: '/api/me/emails', headers: soenke.headers, payload: { email: 'soenke@example.org' } });
    expect(own.statusCode).toBe(409);
    const bad = await t.app.inject({ method: 'POST', url: '/api/me/emails', headers: soenke.headers, payload: { email: 'kein-mail' } });
    expect(bad.statusCode).toBe(400);
    await t.app.inject({ method: 'POST', url: '/api/me/emails', headers: soenke.headers, payload: { email: 'zweit@example.org' } });
    const del = await t.app.inject({ method: 'DELETE', url: '/api/me/emails/zweit%40example.org', headers: soenke.headers });
    expect(del.json().alt_emails).toEqual(['soenke@work.example']);
  });
});

describe('mail import', () => {
  it('ignores unknown senders without asking Claude', async () => {
    const before = t.extractions.length;
    expect(await t.services.mail.process(mail('Spam <spam@evil.example>'))).toBe('ignored');
    expect(t.extractions.length).toBe(before);
    expect(t.sent).toHaveLength(0);
  });

  it('rejects mail that failed DMARC', async () => {
    expect(await t.services.mail.process(mail('soenke@example.org', { authResults: 'spf=fail; dkim=none; dmarc=fail header.from=example.org' }))).toBe(
      'rejected',
    );
  });

  it('creates a trip from the alternative address, adds the other passenger and mails a summary', async () => {
    t.setExtraction(flightBooking);
    const status = await t.services.mail.process(mail('Sönke <SOENKE@work.example>', { authResults: 'dmarc=pass', pdf: Buffer.from('%PDF-1.4\n% test\n') }));
    expect(status).toBe('imported');
    const [trip] = await tripsOf(soenke);
    expect(trip).toMatchObject({ title: 'Mallorca im Juli', start_date: '2027-07-04', end_date: '2027-07-14', segment_count: 2 });
    expect(trip.travelers.map((u: { name: string }) => u.name)).toEqual(['Sönke Jacobs', 'Ulli Jacobs']);
    // The PDF went to Claude as a document and into the trip as attachment.
    expect(t.extractions.at(-1)!.pdfs).toHaveLength(1);
    const full = (await t.app.inject({ method: 'GET', url: `/api/trips/${trip.id}`, headers: soenke.headers })).json();
    expect(full.attachments.map((a: { filename: string }) => a.filename)).toEqual(['Buchung.pdf']);
    expect(full.segments.every((s: { source: string }) => s.source === 'mail')).toBe(true);

    const summary = t.sent.at(-1)!;
    expect(summary.to).toBe('soenke@work.example');
    expect(summary.subject).toBe('Trips: Mallorca im Juli – 2 neu');
    expect(summary.text).toContain('Neue Reise angelegt: Mallorca im Juli');
    expect(summary.text).toContain('EW 9580');
    expect(summary.text).toContain('Als Mitreisende eingetragen: Ulli Jacobs');
    expect(summary.text).toContain(`https://trips.example.org/trips/${trip.id}`);
  });

  it('processes a Message-ID only once', async () => {
    const raw = mail('soenke@example.org');
    t.setExtraction(flightBooking);
    await t.services.mail.process(raw);
    expect(await t.services.mail.process(raw)).toBe('duplicate');
  });

  it('puts a parking booking into the existing trip (within the grace days)', async () => {
    t.setExtraction(parkingBooking);
    expect(await t.services.mail.process(mail('soenke@example.org'))).toBe('imported');
    const trips = await tripsOf(soenke);
    expect(trips).toHaveLength(1);
    const full = (await t.app.inject({ method: 'GET', url: `/api/trips/${trips[0].id}`, headers: soenke.headers })).json();
    const parking = full.segments.find((s: { type: string }) => s.type === 'parking');
    expect(parking).toMatchObject({ title: 'Holiday Parking DUS P7', booking_ref: 'HP-4711', notes: 'Kennzeichen D-SJ 123, Shuttle alle 15 Min.' });
    expect(t.sent.at(-1)!.text).toContain('🅿️ Holiday Parking DUS P7');
  });

  it('updates instead of duplicating, also for parking by booking number', async () => {
    t.setExtraction({
      ...flightBooking,
      segments: [{ ...flightBooking.segments[0]!, start_local: '2027-07-04T08:00', seat: '12A, 12B' }],
    });
    await t.services.mail.process(mail('soenke@example.org'));
    t.setExtraction({ ...parkingBooking, segments: [{ ...parkingBooking.segments[0]!, title: 'Holiday Parking', end_local: '2027-07-15T10:00' }] });
    await t.services.mail.process(mail('soenke@example.org'));
    expect(t.sent.at(-1)!.subject).toContain('1 aktualisiert');
    const [trip] = await tripsOf(soenke);
    const full = (await t.app.inject({ method: 'GET', url: `/api/trips/${trip.id}`, headers: soenke.headers })).json();
    expect(full.segments).toHaveLength(3);
    expect(full.segments.find((s: { number: string }) => s.number === 'EW 9580')).toMatchObject({
      start_local: '2027-07-04T08:00',
      seat: '12A, 12B',
      booking_ref: 'X7Q2PL',
    });
    expect(full.segments.find((s: { type: string }) => s.type === 'parking')).toMatchObject({ end_local: '2027-07-15T10:00', title: 'Holiday Parking' });
    expect(full.end_date).toBe('2027-07-15');
  });

  it('deletes cancelled segments', async () => {
    t.setExtraction({ ...parkingBooking, segments: [{ ...parkingBooking.segments[0]!, cancelled: true, start_local: null, end_local: null }] });
    await t.services.mail.process(mail('soenke@example.org'));
    expect(t.sent.at(-1)!.text).toContain('Gelöscht (storniert)');
    t.setExtraction({ ...flightBooking, segments: [{ ...flightBooking.segments[1]!, cancelled: true }] });
    await t.services.mail.process(mail('ulli@example.org'));
    const [trip] = await tripsOf(soenke);
    const full = (await t.app.inject({ method: 'GET', url: `/api/trips/${trip.id}`, headers: soenke.headers })).json();
    expect(full.segments.map((s: { number: string | null }) => s.number)).toEqual(['EW 9580']);
  });

  it('answers "no booking" and errors with a short mail, without stopping', async () => {
    t.setExtraction({ is_booking: false, trip_title: null, destination: null, passengers: [], segments: [] });
    expect(await t.services.mail.process(mail('ulli@example.org', { subject: 'Newsletter' }))).toBe('no_booking');
    expect(t.sent.at(-1)!.subject).toBe('Trips: keine Buchung erkannt');

    const broken = await createTestApp({
      extract: () => {
        throw new Error('API überlastet');
      },
    });
    await broken.login('Sönke Jacobs', { email: 'soenke@example.org' });
    expect(await broken.services.mail.process(mail('soenke@example.org'))).toBe('error');
    expect(broken.sent.at(-1)!.text).toContain('API überlastet');
    const log = broken.services.mail.recent();
    expect(log[0]).toMatchObject({ status: 'error', detail: 'API überlastet' });
    await broken.close();
  });

  it('logs every mail for admins', async () => {
    const statuses = t.services.mail.recent().map((r) => r.status);
    expect(statuses).toEqual(expect.arrayContaining(['ignored', 'rejected', 'imported', 'no_booking']));
  });
});

describe('"Buchung einfügen" in the app', () => {
  it('puts the segments straight into the chosen trip', async () => {
    const trip = (
      await t.app.inject({
        method: 'POST',
        url: '/api/trips',
        headers: ulli.headers,
        payload: { title: 'Berlin', start_date: '2027-03-01', end_date: '2027-03-03' },
      })
    ).json();
    t.setExtraction({
      is_booking: true,
      trip_title: 'Ganz anderer Titel',
      destination: null,
      passengers: [],
      segments: [
        seg({ type: 'train', number: 'ICE 123', from_name: 'Köln Hbf', to_name: 'Berlin Hbf', start_local: '2027-03-01T08:00', start_tz: 'Europe/Berlin' }),
      ],
    });
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/trips/${trip.id}/import`,
      headers: ulli.headers,
      payload: { text: 'Ihre Fahrkarte ICE 123 Köln – Berlin am 1.3.' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'imported', trip: { id: trip.id, title: 'Berlin' } });
    expect(res.json().summary).toContain('ICE 123 Köln Hbf → Berlin Hbf');
    // Not allowed in someone else's trip.
    const other = await t.app.inject({
      method: 'POST',
      url: `/api/trips/${trip.id}/import`,
      headers: soenke.headers,
      payload: { text: 'Ihre Fahrkarte ICE 123 Köln – Berlin am 1.3.' },
    });
    expect(other.statusCode).toBe(403);
  });
});
