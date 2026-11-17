import { z } from 'zod';
import { isValidLocal, isValidZone } from '../time.js';

/** Shared by REST and MCP: one schema per input, snake_case on the wire. */

export const SEGMENT_TYPES = ['flight', 'train', 'hotel', 'car', 'parking', 'other'] as const;
export type SegmentType = (typeof SEGMENT_TYPES)[number];
export const SOURCES = ['manual', 'mail', 'mcp', 'import'] as const;
export type Source = (typeof SOURCES)[number];

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

const localTime = z
  .string()
  .trim()
  .refine(isValidLocal, 'Zeit als YYYY-MM-DDTHH:MM oder YYYY-MM-DD angeben')
  .nullish()
  .transform((v) => v ?? null)
  .describe('Lokale Zeit am Ort: YYYY-MM-DDTHH:MM oder nur YYYY-MM-DD');

const zone = z
  .string()
  .trim()
  .refine(isValidZone, 'Unbekannte Zeitzone (IANA-Name wie Europe/Berlin erwartet)')
  .nullish()
  .transform((v) => v ?? null)
  .describe('IANA-Zeitzone, z. B. Europe/Berlin');

const code = z
  .string()
  .trim()
  .max(8)
  .nullish()
  .transform((v) => (v ? v.toUpperCase() : null));

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum als YYYY-MM-DD angeben')
  .refine(isValidLocal, 'Ungültiges Datum')
  .nullish()
  .transform((v) => v ?? null);

export const segmentFields = {
  type: z.enum(SEGMENT_TYPES).describe('flight, train, hotel, car (Mietwagen), parking (Parkplatz) oder other'),
  title: text(200).describe('Kurzer Titel; leer lassen = wird aus Typ, Nummer und Orten gebildet. Bei Hotel/Parkplatz: Name des Hotels bzw. Parkhauses'),
  start_local: localTime.describe('Beginn in Ortszeit (Abflug, Abfahrt, Check-in, Abholung, Einfahrt): YYYY-MM-DDTHH:MM oder YYYY-MM-DD'),
  start_tz: zone,
  end_local: localTime.describe('Ende in Ortszeit (Ankunft, Check-out, Rückgabe, Ausfahrt)'),
  end_tz: zone,
  from_name: text(200).describe('Abflug-/Abfahrtsort oder Abholort'),
  from_code: code.describe('IATA-Code bei Flügen, z. B. DUS'),
  to_name: text(200),
  to_code: code,
  carrier: text(100).describe('Airline, Bahn, Vermieter, Parkplatzanbieter'),
  number: text(40).describe('Flug-/Zugnummer, z. B. "LH 2010" oder "ICE 123"'),
  booking_ref: text(80).describe('Buchungsnummer / PNR'),
  seat: text(80).describe('Sitzplatz, Zimmer oder Stellplatz/Ebene'),
  address: text(400).describe('Adresse (Hotel, Parkhaus, Vermietstation)'),
  notes: text(4000).describe('Notizen, bei Parkplätzen Kennzeichen, Shuttle, Zugang (Schranke, QR-Code, Telefon)'),
};

export const SegmentInput = z.object(segmentFields);
export type SegmentInput = z.output<typeof SegmentInput>;

/** For updates: every field optional, only given ones change. */
export const SegmentPatch = z.object(segmentFields).partial();
export type SegmentPatch = z.output<typeof SegmentPatch>;

export const tripFields = {
  title: z.string().trim().min(1, 'Titel fehlt').max(200),
  destination: text(200),
  start_date: date,
  end_date: date,
  notes: text(8000),
  traveler_ids: z.array(z.string()).max(50).optional().describe('IDs der Reisenden (siehe list_users); leer = nur du'),
};
export const TripInput = z.object(tripFields);
export type TripInput = z.output<typeof TripInput>;
export const TripPatch = z.object(tripFields).partial();
export type TripPatch = z.output<typeof TripPatch>;
