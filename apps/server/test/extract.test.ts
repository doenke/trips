import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { describe, expect, it } from 'vitest';
import { cleanExtraction, fromWire, SYSTEM_PROMPT, WireSchema } from '../src/extract/claude.js';

/** Parameters with a type array or anyOf – the API refuses schemas with more than 16 of them. */
function unionCount(node: unknown): number {
  if (!node || typeof node !== 'object') return 0;
  const n = node as Record<string, unknown>;
  let count = Array.isArray(n.type) || n.anyOf ? 1 : 0;
  for (const v of Object.values(n)) count += unionCount(v);
  return count;
}

describe('extraction schema for the Claude API', () => {
  it('stays below the structured-output limit of 16 union-typed parameters', () => {
    const format = betaZodOutputFormat(WireSchema) as unknown as { schema: unknown };
    expect(unionCount(format.schema)).toBe(0);
  });

  it('turns empty strings back into "unknown"', () => {
    const blank = {
      title: '',
      start_local: '',
      start_tz: '',
      end_local: '',
      end_tz: '',
      from_name: '',
      from_code: '',
      to_name: '',
      to_code: '',
      carrier: '',
      number: '',
      booking_ref: '',
      seat: '',
      address: '',
      notes: '',
    };
    const e = cleanExtraction(
      fromWire({
        is_booking: true,
        trip_title: '  ',
        destination: 'Wien',
        passengers: ['LINDNER/MIA MRS'],
        segments: [
          {
            ...blank,
            type: 'flight',
            number: 'EW 9754',
            from_code: 'dus',
            to_code: 'VIE',
            start_local: '2026-11-23T16:50',
            start_tz: 'Europe/Berlin',
            cancelled: false,
            documents: ['E-Ticket.pdf'],
          },
        ],
      }),
    );
    expect(e).toMatchObject({ trip_title: null, destination: 'Wien' });
    expect(e.segments[0]).toMatchObject({ type: 'flight', number: 'EW 9754', from_code: 'DUS', title: null, end_local: null, seat: null, cancelled: false });
    expect(SYSTEM_PROMPT).toContain('empty string');
    expect(SYSTEM_PROMPT).not.toMatch(/\bnull\b/);
  });
});
