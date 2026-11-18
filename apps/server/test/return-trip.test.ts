import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Extraction } from '../src/extract/claude.js';
import { fitsTrip, returnDay } from '../src/service/matching.js';
import { createTestApp, rawMail, seg, type TestApp } from './helpers.js';

const leg = (from: string, to: string, day: string, type: 'flight' | 'train' = 'flight', time = '10:00') => ({
  type,
  from_code: type === 'flight' ? from : null,
  from_name: type === 'train' ? from : null,
  to_code: type === 'flight' ? to : null,
  to_name: type === 'train' ? to : null,
  start_local: `${day}T${time}`,
  end_local: `${day}T23:00`,
});

describe('return to the start', () => {
  it('finds the day the trip gets back to where it began', () => {
    expect(returnDay([leg('DUS', 'VIE', '2026-11-23'), leg('VIE', 'DUS', '2026-11-26')])).toBe('2026-11-26');
    // Order of the list doesn't matter; stops on the way don't count as return.
    expect(
      returnDay([leg('PMI', 'DUS', '2027-07-14'), leg('FRA', 'PMI', '2027-07-04', 'flight', '13:00'), leg('DUS', 'FRA', '2027-07-04', 'flight', '07:00')]),
    ).toBe('2027-07-14');
    expect(returnDay([leg('DUS', 'VIE', '2026-11-23')])).toBeNull();
    // Back to another airport: not recognized as return (the grace days still apply).
    expect(returnDay([leg('DUS', 'VIE', '2026-11-23'), leg('VIE', 'CGN', '2026-11-26')])).toBeNull();
    // Trains by station name, case and accents ignored.
    expect(returnDay([leg('Köln Hbf', 'Berlin Hbf', '2027-03-01', 'train'), leg('Berlin Hbf', 'KÖLN HBF', '2027-03-03', 'train')])).toBe('2027-03-03');
    // Hotels and parking don't make a trip start or end.
    expect(
      returnDay([{ type: 'hotel', from_code: null, from_name: null, to_code: null, to_name: null, start_local: '2026-11-23', end_local: '2026-11-26' }]),
    ).toBeNull();
  });

  it('uses the grace days only while the way back is missing', () => {
    const open = { id: 'a', start_date: '2026-11-23', end_date: '2026-11-26', travelerIds: [], returnDay: null };
    const closed = { ...open, returnDay: '2026-11-26' };
    // Open: ±5 days
    expect(fitsTrip(open, '2026-11-29', '2026-11-29', 5)).toBe(true);
    expect(fitsTrip(open, '2026-11-18', '2026-11-18', 5)).toBe(true);
    // Closed: up to the day of the return …
    expect(fitsTrip(closed, '2026-11-26', '2026-11-27', 5)).toBe(true); // airport hotel that night
    expect(fitsTrip(closed, '2026-11-27', '2026-11-27', 5)).toBe(false); // next day: a new trip
    // … and one day before the start
    expect(fitsTrip(closed, '2026-11-22', '2026-11-23', 5)).toBe(true); // hotel the evening before
    expect(fitsTrip(closed, '2026-11-20', '2026-11-20', 5)).toBe(false);
  });
});

describe('mail import with a complete trip', () => {
  let t: TestApp;
  let n = 0;
  const send = async (e: Extraction) => {
    t.setExtraction(e);
    await t.services.mail.process(rawMail({ from: 'anna@example.org', subject: 'Buchung', text: 'Buchung', messageId: `rt-${++n}@example.org` }));
    return t.sent.at(-1)!;
  };
  const booking = (title: string, segments: Extraction['segments']): Extraction => ({
    is_booking: true,
    trip_title: title,
    destination: null,
    passengers: [],
    segments,
  });

  beforeAll(async () => {
    t = await createTestApp();
    await t.login('Anna');
  });
  afterAll(async () => t?.close());

  it('keeps the airport hotel on the last day, starts a new trip the day after', async () => {
    await send(
      booking('Wien', [
        seg({ type: 'flight', number: 'EW 9754', from_code: 'DUS', to_code: 'VIE', start_local: '2026-11-23T16:50', end_local: '2026-11-23T18:25' }),
        seg({ type: 'flight', number: 'EW 9753', from_code: 'VIE', to_code: 'DUS', start_local: '2026-11-26T19:15', end_local: '2026-11-26T20:45' }),
      ]),
    );
    const hotel = await send(booking('Hotel', [seg({ type: 'hotel', title: 'Airport Hotel DUS', start_local: '2026-11-26', end_local: '2026-11-27' })]));
    expect(hotel.text).toContain('Reise: Wien');
    const next = await send(booking('London', [seg({ type: 'flight', number: 'EW 9460', from_code: 'DUS', to_code: 'LHR', start_local: '2026-11-27T09:00' })]));
    expect(next.text).toContain('Neue Reise angelegt: London');
  });

  it('still uses the grace days while the return is missing', async () => {
    await send(booking('Rom', [seg({ type: 'flight', number: 'AZ 401', from_code: 'DUS', to_code: 'FCO', start_local: '2027-04-02T09:00' })]));
    const later = await send(
      booking('Rom zurück', [seg({ type: 'flight', number: 'AZ 402', from_code: 'FCO', to_code: 'DUS', start_local: '2027-04-06T18:00' })]),
    );
    expect(later.text).toContain('Reise: Rom');
  });
});
