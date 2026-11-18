import zones from './data/airport-zones.json';

/**
 * IATA airport code → IANA time zone, from github.com/mwgg/Airports (MIT). Stored per zone as one
 * string of 3-letter codes to keep the bundle small (~30 KB for ~7900 airports).
 */
let index: Map<string, string> | null = null;

export function airportZone(code: string | null | undefined): string | null {
  if (!code) return null;
  if (!index) {
    index = new Map();
    for (const [zone, codes] of Object.entries(zones as Record<string, string>)) {
      for (let i = 0; i < codes.length; i += 3) index.set(codes.slice(i, i + 3), zone);
    }
  }
  return index.get(code.trim().toUpperCase()) ?? null;
}
