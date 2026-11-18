import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { airportZone } from '../src/airports.js';
import { flightNumber, tripitToExport } from '../src/service/tripit.js';
import { createTestApp, type TestApp } from './helpers.js';

/** Made-up data in the structure of a TripIt dump. */
const dump = [
  {
    trips: [
      {
        tripUuid: 'u1',
        tripId: '1',
        name: 'Lisbon, Portugal, June 2027',
        location: 'Lisbon, Portugal',
        startDate: '2027-06-10',
        endDate: '2027-06-14',
        counts: {},
        flights: [
          {
            uid: 'f1',
            flightCode: 'TP575',
            from: 'DUS',
            to: 'LIS',
            airline: 'TAP',
            flightNumber: '575',
            departUtc: '2027-06-10T06:00:00Z',
            arriveUtc: '2027-06-10T09:00:00Z',
            departPlace: 'Dusseldorf (DUS)',
            layover: null,
          },
          {
            uid: 'f2',
            flightCode: 'TP576',
            from: 'LIS',
            to: 'DUS',
            airline: 'TAP',
            flightNumber: '576',
            departUtc: '2027-06-14T17:00:00Z',
            arriveUtc: '2027-06-14T20:00:00Z',
            departPlace: 'Lisbon (LIS)',
            layover: null,
          },
        ],
        accommodations: [
          {
            name: 'Casa Azul',
            address: 'Rua Azul 1, Lisboa',
            phone: '+351 1234',
            checkIn: '2027-06-10T14:00:00Z',
            checkInLocal: '15:00',
            checkOut: '2027-06-14T10:00:00Z',
            checkOutLocal: '11:00',
            uids: [],
          },
          {
            name: 'Depart Lodging',
            address: null,
            phone: null,
            checkIn: null,
            checkOut: '2027-06-12T10:00:00Z',
            uids: [],
            warning: 'Check-out ohne passendes Check-in',
          },
        ],
        parkings: [
          {
            name: 'Parkplatz P23',
            address: 'Flughafenstraße 1, Düsseldorf',
            phone: '0211 1',
            dropOff: '2027-06-10T04:30:00Z',
            pickUp: '2027-06-14T20:45:00Z',
            uids: [],
          },
        ],
        others: [
          {
            uid: 'o1',
            type: 'Car Rental',
            name: 'Pick Up Rental Car: Europcar',
            address: 'Lisbon Airport',
            start: '2027-06-11T08:00:00Z',
            end: '2027-06-11T09:00:00Z',
          },
          {
            uid: 'o2',
            type: 'Car Rental',
            name: 'Drop Off Rental Car: Europcar',
            address: 'Lisbon Downtown',
            start: '2027-06-13T16:00:00Z',
            end: '2027-06-13T17:00:00Z',
          },
          { uid: 'o3', type: 'Rail', name: 'CP - Lisboa Oriente to Porto Campanhã', address: null, start: '2027-06-12', end: '2027-06-12' },
          {
            uid: 'o4',
            type: 'Restaurant',
            name: 'Cervejaria Ramiro',
            address: 'Av. Almirante Reis 1',
            start: '2027-06-12T19:00:00Z',
            end: '2027-06-12T21:00:00Z',
          },
        ],
        warnings: [],
        listName: 'Lisbon, Portugal, June 2027',
        tripitId: '1',
      },
      {
        tripUuid: 'u2',
        tripId: '2',
        name: 'Hamburg, May 2027',
        location: null,
        startDate: '2027-05-01',
        endDate: '2027-05-02',
        flights: [],
        accommodations: [
          { name: 'Hotel Elbe', checkIn: '2027-05-01T13:00:00Z', checkInLocal: '15:00', checkOut: '2027-05-02T09:00:00Z', checkOutLocal: '11:00', uids: [] },
        ],
        parkings: [],
        others: [],
        warnings: [],
      },
    ],
  },
];

describe('TripIt mapping', () => {
  const trips = tripitToExport(dump)!;
  const lisbon = trips[0]!;
  const seg = (type: string) => lisbon.segments.filter((s) => s.type === type);

  it('recognizes the dump and nothing else', () => {
    expect(trips).toHaveLength(2);
    expect(tripitToExport({ format: 'trips-export', version: 1, trips: [] })).toBeNull();
    expect(tripitToExport({ hello: 1 })).toBeNull();
    expect(lisbon).toMatchObject({ title: 'Lisbon, Portugal, June 2027', destination: 'Lisbon, Portugal', start_date: '2027-06-10', end_date: '2027-06-14' });
  });

  it('converts flight times from UTC to local time of each airport', () => {
    expect(airportZone('LIS')).toBe('Europe/Lisbon');
    expect(flightNumber('TP575')).toBe('TP 575');
    expect(seg('flight')[0]).toMatchObject({
      number: 'TP 575',
      carrier: 'TAP',
      from_code: 'DUS',
      from_name: 'Dusseldorf',
      to_code: 'LIS',
      start_local: '2027-06-10T08:00',
      start_tz: 'Europe/Berlin',
      end_local: '2027-06-10T10:00',
      end_tz: 'Europe/Lisbon',
    });
  });

  it('uses the local clock time for hotels and the nearby airport zone', () => {
    expect(seg('hotel')[0]).toMatchObject({
      title: 'Casa Azul',
      start_local: '2027-06-10T15:00',
      start_tz: 'Europe/Lisbon',
      end_local: '2027-06-14T11:00',
      end_tz: 'Europe/Lisbon',
      notes: 'Telefon: +351 1234',
    });
    // Half a booking: only the check-out, with TripIt's warning.
    expect(seg('hotel')[1]).toMatchObject({ start_local: null, end_local: '2027-06-12T11:00', notes: 'TripIt: Check-out ohne passendes Check-in' });
  });

  it('maps parking, rental car pairs, rail and the rest', () => {
    expect(seg('parking')[0]).toMatchObject({
      title: 'Parkplatz P23',
      start_local: '2027-06-10T06:30',
      start_tz: 'Europe/Berlin',
      end_local: '2027-06-14T22:45',
    });
    expect(seg('car')).toEqual([
      expect.objectContaining({
        carrier: 'Europcar',
        from_name: 'Lisbon Airport',
        to_name: 'Lisbon Downtown',
        start_local: '2027-06-11T09:00',
        end_local: '2027-06-13T17:00',
      }),
    ]);
    expect(seg('train')[0]).toMatchObject({ carrier: 'CP', from_name: 'Lisboa Oriente', to_name: 'Porto Campanhã', start_local: '2027-06-12', start_tz: null });
    expect(seg('other')[0]).toMatchObject({ title: 'Cervejaria Ramiro', notes: 'Restaurant', start_local: '2027-06-12T20:00' });
  });

  it('falls back to the home zone for trips without flights', () => {
    expect(trips[1]!.segments[0]).toMatchObject({ start_local: '2027-05-01T15:00', start_tz: 'Europe/Berlin' });
  });
});

describe('TripIt import', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t?.close());

  it('imports for the admin, skips on a second run, and sends flights to AirTrail', async () => {
    const admin = await t.login('Anna', { admin: true });
    await t.app.inject({ method: 'PUT', url: '/api/me/airtrail', headers: admin.headers, payload: { key: 'key-anna' } });
    t.airtrail.airports.push({ id: 9, iata: 'LIS', icao: 'LPPT', timezone: 'Europe/Lisbon' });
    const first = (await t.app.inject({ method: 'POST', url: '/api/admin/import', headers: admin.headers, payload: dump })).json();
    expect(first.created.map((c: { title: string; segments: number }) => [c.title, c.segments])).toEqual([
      ['Lisbon, Portugal, June 2027', 8],
      ['Hamburg, May 2027', 1],
    ]);
    const trip = (await t.app.inject({ method: 'GET', url: `/api/trips/${first.created[0].id}`, headers: admin.headers })).json();
    expect(trip.travelers.map((u: { name: string }) => u.name)).toEqual(['Anna']);
    expect(trip.segments.every((s: { source: string }) => s.source === 'import')).toBe(true);
    await t.idle();
    expect(t.airtrail.flights.size).toBe(2);
    const again = (await t.app.inject({ method: 'POST', url: '/api/admin/import', headers: admin.headers, payload: dump })).json();
    expect(again.created).toEqual([]);
    expect(again.skipped).toHaveLength(2);
  });
});
