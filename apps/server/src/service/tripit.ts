import type { ExportedTrip } from './exchange.js';

/**
 * Converts a TripIt dump into the export format. The mapping follows the real structure of the
 * dump once a sample is available; until then nothing is recognized as TripIt.
 */
export function tripitToExport(_data: unknown): ExportedTrip[] | null {
  return null;
}
