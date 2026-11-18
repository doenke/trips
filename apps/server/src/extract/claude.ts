import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { SEGMENT_TYPES } from '../service/schemas.js';
import { isValidLocal, isValidZone } from '../time.js';

/** A booking as Trips works with it: null where the document says nothing. */
export const ExtractionSchema = z.object({
  is_booking: z.boolean(),
  trip_title: z.string().nullable(),
  destination: z.string().nullable(),
  passengers: z.array(z.string()),
  segments: z.array(
    z.object({
      type: z.enum(SEGMENT_TYPES),
      title: z.string().nullable(),
      start_local: z.string().nullable(),
      start_tz: z.string().nullable(),
      end_local: z.string().nullable(),
      end_tz: z.string().nullable(),
      from_name: z.string().nullable(),
      from_code: z.string().nullable(),
      to_name: z.string().nullable(),
      to_code: z.string().nullable(),
      carrier: z.string().nullable(),
      number: z.string().nullable(),
      booking_ref: z.string().nullable(),
      seat: z.string().nullable(),
      address: z.string().nullable(),
      notes: z.string().nullable(),
      cancelled: z.boolean(),
      /** File names of the attached PDFs this segment is in (e-ticket, hotel voucher …). */
      documents: z.array(z.string()),
    }),
  ),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

/**
 * What the model fills in. Structured outputs allow at most 16 nullable (union-typed) fields, and a
 * booking has more – so every value is a plain string here, "" meaning unknown, mapped back to null
 * by fromWire(). Never make fields of this schema nullable or optional.
 */
const wireSegment = z.object(
  Object.fromEntries(
    Object.entries(ExtractionSchema.shape.segments.element.shape).map(([k, v]) => [k, k === 'type' || k === 'cancelled' || k === 'documents' ? v : z.string()]),
  ) as { [K in keyof ExtractedSegmentShape]: K extends 'type' | 'cancelled' | 'documents' ? ExtractedSegmentShape[K] : z.ZodString },
);
type ExtractedSegmentShape = typeof ExtractionSchema.shape.segments.element.shape;
export const WireSchema = z.object({
  is_booking: z.boolean(),
  trip_title: z.string(),
  destination: z.string(),
  passengers: z.array(z.string()),
  segments: z.array(wireSegment),
});
type Wire = z.infer<typeof WireSchema>;

const orNull = (v: string) => (v.trim() ? v.trim() : null);

export function fromWire(w: Wire): Extraction {
  return {
    is_booking: w.is_booking,
    trip_title: orNull(w.trip_title),
    destination: orNull(w.destination),
    passengers: w.passengers,
    segments: w.segments.map((s) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s)) out[k] = typeof v === 'string' && k !== 'type' ? orNull(v) : v;
      return out as ExtractedSegment;
    }),
  };
}
export type ExtractedSegment = Extraction['segments'][number];

export interface ExtractInput {
  text: string;
  subject?: string | null;
  pdfs: { filename: string; data: Buffer }[];
  /** Today's date (YYYY-MM-DD), so "Sa., 12. Juli" gets the right year. */
  today: string;
}

export type Extractor = (input: ExtractInput) => Promise<Extraction>;

export const SYSTEM_PROMPT = `You extract travel bookings from emails, pasted text and PDF documents for a personal trip planner.

Rules:
- Never invent anything. Use an empty string "" for every value the document does not state.
- is_booking = false for newsletters, advertising, price alerts, surveys, check-in reminders without booking data and anything else that is not a booking, booking change or cancellation. Then return no segments.
- One segment per flight leg (a connection DUS–FRA–JFK is two segments). Trains likewise per train when train numbers are given.
- Hotels: one segment from check-in (start) to check-out (end); title = hotel name, address = hotel address, seat = room if stated.
- Rental cars (type car): pick-up = start, return = end, from_name/to_name = stations, carrier = rental company.
- Parking bookings (airport, station or hotel parking) are type "parking", never "other": title = car park / provider (e.g. "Holiday Parking DUS P7"), start = entry, end = exit, address = car park address, booking_ref = booking number, seat = space/level if stated. Put licence plate, shuttle information and access hints (barrier, QR code, phone number) into notes.
- Times: start_local / end_local as local time at that place, format YYYY-MM-DDTHH:MM, or YYYY-MM-DD if no time is given. start_tz / end_tz = IANA time zone of the place (e.g. Europe/Berlin, America/New_York) – derive it from the airport or city.
- Flights: from_code / to_code = IATA airport codes, number = flight number with airline code and a space ("LH 2010"), carrier = airline name.
- Trains: number like "ICE 123", from_name / to_name = stations.
- booking_ref = booking code / PNR / confirmation number.
- seat = seat(s), e.g. "12A" or "12A, 12B".
- cancelled = true when the document cancels this segment. For a changed booking return the new data with cancelled = false.
- documents = the file names (as given in the document titles) of the attached PDFs that contain this segment, e.g. the e-ticket for both flights, the hotel voucher for the hotel. Empty list if none or if the booking is only in the mail text.
- passengers = names of all travellers exactly as written (e.g. "LINDNER/JOERG MR").
- trip_title: a short German title for the trip, e.g. "Mallorca im Juli" or "Messe Berlin"; destination = main destination city or region.
- Write trip_title, segment titles and notes in German.`;

/** Drops values that don't fit our formats instead of failing the whole booking. */
export function cleanExtraction(e: Extraction): Extraction {
  const local = (v: string | null) => (v && isValidLocal(v.trim()) ? v.trim() : null);
  const zone = (v: string | null) => (v && isValidZone(v.trim()) ? v.trim() : null);
  const code = (v: string | null) => (v && /^[A-Za-z0-9]{3,4}$/.test(v.trim()) ? v.trim().toUpperCase() : null);
  return {
    ...e,
    passengers: e.passengers.filter((p) => p && p.trim()),
    segments: e.segments.map((s) => ({
      ...s,
      start_local: local(s.start_local),
      end_local: local(s.end_local),
      start_tz: zone(s.start_tz),
      end_tz: zone(s.end_tz),
      from_code: code(s.from_code),
      to_code: code(s.to_code),
    })),
  };
}

export function claudeExtractor(opts: { apiKey: string; model: string }): Extractor {
  const client = new Anthropic({ apiKey: opts.apiKey });
  return async (input) => {
    const content: Anthropic.Beta.BetaContentBlockParam[] = input.pdfs.map((p) => ({
      type: 'document' as const,
      source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: p.data.toString('base64') },
      title: p.filename,
    }));
    if (input.pdfs.length) content.push({ type: 'text', text: `Attached PDF documents: ${input.pdfs.map((p) => `"${p.filename}"`).join(', ')}` });
    content.push({
      type: 'text',
      text: `Today is ${input.today}.\n${input.subject ? `Subject: ${input.subject}\n` : ''}\n${input.text.slice(0, 150_000) || '(no text, see the attached documents)'}`,
    });
    const response = await client.beta.messages.parse({
      model: opts.model,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
      output_config: { format: betaZodOutputFormat(WireSchema) },
      // On a policy decline the API retries on a fallback model instead of returning nothing.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    if (response.stop_reason === 'refusal') throw new Error('Claude hat die Auswertung abgelehnt.');
    if (response.stop_reason === 'max_tokens') throw new Error('Die Antwort von Claude war zu lang und wurde abgeschnitten.');
    const parsed = WireSchema.safeParse(response.parsed_output);
    if (!parsed.success) throw new Error('Claude hat kein gültiges Ergebnis geliefert.');
    return cleanExtraction(fromWire(parsed.data));
  };
}
