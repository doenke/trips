import { describe, expect, it } from 'vitest';
import { splitFlightNumber } from '../src/airtrail/sync.js';
import { pickTrip, sameSegment, type SegmentKey } from '../src/service/matching.js';
import { matchPassengers, namesMatch } from '../src/service/names.js';
import { localToIsoOffset, localToUtc, zoneOffsetMinutes } from '../src/time.js';

describe('time zones', () => {
  it('converts local time to UTC in summer and winter', () => {
    expect(localToUtc('2026-07-01T10:00', 'Europe/Berlin').toISOString()).toBe('2026-07-01T08:00:00.000Z');
    expect(localToUtc('2026-01-15T10:00', 'Europe/Berlin').toISOString()).toBe('2026-01-15T09:00:00.000Z');
    expect(localToUtc('2026-07-01T10:00', 'America/New_York').toISOString()).toBe('2026-07-01T14:00:00.000Z');
  });

  it('handles the DST change days', () => {
    // Spring forward in Berlin: 2026-03-29 02:00 → 03:00
    expect(localToUtc('2026-03-29T01:30', 'Europe/Berlin').toISOString()).toBe('2026-03-29T00:30:00.000Z');
    expect(localToUtc('2026-03-29T03:30', 'Europe/Berlin').toISOString()).toBe('2026-03-29T01:30:00.000Z');
    // 02:30 doesn't exist: moved forward to 03:30 CEST
    expect(localToUtc('2026-03-29T02:30', 'Europe/Berlin').toISOString()).toBe('2026-03-29T01:30:00.000Z');
    // Fall back: 2026-10-25 02:30 happens twice – the earlier (CEST) one
    expect(localToUtc('2026-10-25T02:30', 'Europe/Berlin').toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(localToUtc('2026-10-25T04:00', 'Europe/Berlin').toISOString()).toBe('2026-10-25T03:00:00.000Z');
    // US change on a different weekend
    expect(localToUtc('2026-03-08T12:00', 'America/New_York').toISOString()).toBe('2026-03-08T16:00:00.000Z');
  });

  it('formats ISO with offset for AirTrail', () => {
    expect(localToIsoOffset('2026-07-01T10:05', 'Europe/Berlin')).toBe('2026-07-01T10:05:00+02:00');
    expect(localToIsoOffset('2026-12-01T23:30', 'America/Los_Angeles')).toBe('2026-12-01T23:30:00-08:00');
    expect(localToIsoOffset('2026-12-01T09:00', 'Asia/Kolkata')).toBe('2026-12-01T09:00:00+05:30');
    expect(zoneOffsetMinutes(new Date('2026-07-01T00:00:00Z'), 'Europe/Berlin')).toBe(120);
  });

  it('treats date-only values as midnight', () => {
    expect(localToUtc('2026-07-01', 'Europe/Berlin').toISOString()).toBe('2026-06-30T22:00:00.000Z');
  });
});

describe('passenger names', () => {
  it('matches airline spellings', () => {
    expect(namesMatch('JACOBS/SOENKE MR', 'Sönke Jacobs')).toBe(true);
    expect(namesMatch('JACOBS/SONKE MR', 'Sönke Jacobs')).toBe(true);
    expect(namesMatch('Jacobs, Sönke', 'Sönke Jacobs')).toBe(true);
    expect(namesMatch('JACOBS/SOENKEMR', 'Sönke Jacobs')).toBe(true);
    expect(namesMatch('Herr Sönke Jacobs', 'sönke jacobs')).toBe(true);
    expect(namesMatch('MÜLLER/ANNA MARIA MRS', 'Anna Müller')).toBe(true);
  });

  it('does not match different people', () => {
    expect(namesMatch('JACOBS/ULLI MRS', 'Sönke Jacobs')).toBe(false);
    expect(namesMatch('JACOBS', 'Sönke Jacobs')).toBe(false);
    expect(namesMatch('MEIER/SOENKE MR', 'Sönke Jacobs')).toBe(false);
  });

  it('picks the matching users', () => {
    const users = [
      { id: '1', name: 'Sönke Jacobs' },
      { id: '2', name: 'Ulli Jacobs' },
      { id: '3', name: 'Anna Müller' },
    ];
    expect(matchPassengers(['JACOBS/SOENKE MR', 'JACOBS/ULLI MRS'], users).map((u) => u.id)).toEqual(['1', '2']);
  });
});

describe('trip matching', () => {
  const trips = [
    { id: 'a', start_date: '2026-07-01', end_date: '2026-07-10', travelerIds: ['me'] },
    { id: 'b', start_date: '2026-07-03', end_date: '2026-07-08', travelerIds: ['me', 'ulli'] },
    { id: 'c', start_date: '2026-09-01', end_date: '2026-09-05', travelerIds: ['me'] },
    { id: 'd', start_date: '2026-07-01', end_date: '2026-07-10', travelerIds: ['someone'] },
  ];

  it('uses ±grace days', () => {
    expect(pickTrip(trips, '2026-09-08', '2026-09-08', ['me'], 5)?.id).toBe('c');
    expect(pickTrip(trips, '2026-09-11', '2026-09-11', ['me'], 5)).toBeNull();
    expect(pickTrip(trips, '2026-08-27', '2026-08-27', ['me'], 5)?.id).toBe('c');
    expect(pickTrip(trips, '2026-09-11', '2026-09-11', ['me'], 6)?.id).toBe('c');
  });

  it('prefers shared travelers, then the closest trip', () => {
    expect(pickTrip(trips, '2026-07-05', '2026-07-05', ['me', 'ulli'], 5)?.id).toBe('b');
    expect(pickTrip(trips, '2026-07-05', '2026-07-05', ['me'], 5)?.id).toBe('a');
    expect(pickTrip(trips, '2026-07-05', '2026-07-05', ['nobody'], 5)).toBeNull();
  });
});

describe('duplicates', () => {
  const base: SegmentKey = { type: 'flight', title: null, start_local: '2026-07-01T10:00', number: 'LH 2010', booking_ref: 'ABC123' };
  it('flights: same day and number', () => {
    expect(sameSegment(base, { ...base, number: 'LH2010', start_local: '2026-07-01T11:30' })).toBe(true);
    expect(sameSegment(base, { ...base, number: 'LH 2011' })).toBe(false);
    expect(sameSegment(base, { ...base, start_local: '2026-07-02T10:00' })).toBe(false);
    // Same PNR, other leg: not the same
    expect(sameSegment(base, { ...base, number: 'LH 400' })).toBe(false);
    // Cancellation without date
    expect(sameSegment(base, { ...base, start_local: null })).toBe(true);
  });

  it('parking: booking number, else provider on the same entry day', () => {
    const p: SegmentKey = { type: 'parking', title: 'Holiday Parking DUS P7', start_local: '2026-07-01T06:00', number: null, booking_ref: 'HP-4711' };
    expect(sameSegment(p, { ...p, start_local: '2026-07-02T06:00', title: 'Anderes Parkhaus' })).toBe(true);
    expect(sameSegment(p, { ...p, booking_ref: 'HP-9999' })).toBe(false);
    const noRef = { ...p, booking_ref: null };
    expect(sameSegment(noRef, { ...noRef, start_local: '2026-07-01T08:00' })).toBe(true);
    expect(sameSegment(noRef, { ...noRef, start_local: '2026-07-03T08:00' })).toBe(false);
    expect(sameSegment(p, { ...p, type: 'hotel' })).toBe(false);
  });
});

describe('flight numbers', () => {
  it('splits airline code and number', () => {
    expect(splitFlightNumber('LH 2010', null)).toEqual({ airline: 'LH', number: 'LH2010' });
    expect(splitFlightNumber('U2 1234', null)).toEqual({ airline: 'U2', number: 'U21234' });
    expect(splitFlightNumber('EWG123', null)).toEqual({ airline: 'EWG', number: 'EWG123' });
  });
});
