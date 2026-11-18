/** Minimal client for the AirTrail API v1 (Bearer API key per user). */

export class AirTrailError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Airport {
  id: number | string;
  iata: string | null;
  icao: string | null;
  timezone: string | null;
}

export interface Airline {
  id: number | string;
  iata: string | null;
  icao: string | null;
}

export interface FlightBody {
  date: string;
  datePrecision: 'day';
  departure?: string | null;
  arrival?: string | null;
  fromId: number | string;
  toId: number | string;
  airlineId?: number | string | null;
  flightNumber?: string | null;
  note?: string | null;
  passengers: {
    id?: number;
    userId: string | null;
    guestName?: string | null;
    seat?: string | null;
    seatNumber?: string | null;
    seatClass?: string | null;
    flightReason?: string | null;
  }[];
  [field: string]: unknown;
}

/** A flight as AirTrail returns it (only the fields Trips uses or must keep on update). */
export interface AirTrailFlight {
  id: number | string;
  date: string;
  datePrecision?: string | null;
  departure?: string | null;
  arrival?: string | null;
  departureScheduled?: string | null;
  arrivalScheduled?: string | null;
  takeoffScheduled?: string | null;
  takeoffActual?: string | null;
  landingScheduled?: string | null;
  landingActual?: string | null;
  duration?: number | null;
  departureTerminal?: string | null;
  departureGate?: string | null;
  arrivalTerminal?: string | null;
  arrivalGate?: string | null;
  flightNumber?: string | null;
  aircraftReg?: string | null;
  note?: string | null;
  from: { id: number | string; iata: string | null; icao: string | null } | null;
  to: { id: number | string; iata: string | null; icao: string | null } | null;
  airline?: { id: number | string } | null;
  aircraft?: { id: number | string } | null;
  passengers: {
    id?: number;
    user: { id: string } | null;
    guestName?: string | null;
    seat?: string | null;
    seatNumber?: string | null;
    seatClass?: string | null;
    flightReason?: string | null;
  }[];
}

type Fetch = typeof fetch;

export class AirTrailClient {
  private readonly airports = new Map<string, Airport | null>();
  private readonly airlines = new Map<string, Airline | null>();

  constructor(
    readonly baseUrl: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private async call<T>(key: string, method: string, path: string, body?: unknown): Promise<T | null> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new AirTrailError(0, `AirTrail nicht erreichbar (${(err as Error).message})`);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 200);
      try {
        const j = JSON.parse(text) as { message?: string; error?: string };
        detail = j.message ?? j.error ?? detail;
      } catch {
        /* plain text */
      }
      const hint = res.status === 401 || res.status === 403 ? 'API-Key ungültig' : `HTTP ${res.status}`;
      throw new AirTrailError(res.status, detail ? `${hint}: ${detail}` : hint);
    }
    return text ? (JSON.parse(text) as T) : null;
  }

  /** Checks a key; returns the AirTrail user. */
  async me(key: string): Promise<{ id: string; name: string }> {
    const r = await this.call<{ data?: Record<string, unknown> } & Record<string, unknown>>(key, 'GET', '/api/v1/me');
    const u = (r?.data ?? r ?? {}) as Record<string, unknown>;
    if (!u.id) throw new AirTrailError(500, 'Unerwartete Antwort von /api/v1/me');
    return { id: String(u.id), name: String(u.displayName ?? u.username ?? u.name ?? '') };
  }

  async airport(key: string, code: string): Promise<Airport | null> {
    const c = code.toUpperCase();
    if (this.airports.has(c)) return this.airports.get(c)!;
    const r = await this.call<{ data?: Airport[] }>(key, 'GET', `/api/v1/airports?query=${encodeURIComponent(c)}`);
    const hit = (r?.data ?? []).find((a) => a.iata?.toUpperCase() === c || a.icao?.toUpperCase() === c) ?? null;
    this.airports.set(c, hit);
    return hit;
  }

  async airline(key: string, code: string): Promise<Airline | null> {
    const c = code.toUpperCase();
    if (this.airlines.has(c)) return this.airlines.get(c)!;
    const r = await this.call<{ data?: Airline[] }>(key, 'GET', `/api/v1/airlines?query=${encodeURIComponent(c)}`);
    const hit = (r?.data ?? []).find((a) => a.iata?.toUpperCase() === c || a.icao?.toUpperCase() === c) ?? null;
    this.airlines.set(c, hit);
    return hit;
  }

  /** All flights of the key's user (scope "mine"), page by page. */
  async listFlights(key: string): Promise<AirTrailFlight[]> {
    const all: AirTrailFlight[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 200; page++) {
      const q: string = `/api/v1/flights?scope=mine&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const r: { data?: AirTrailFlight[]; page?: { nextCursor?: string | null } } | null = await this.call(key, 'GET', q);
      all.push(...(r?.data ?? []));
      cursor = r?.page?.nextCursor ?? null;
      if (!cursor) break;
    }
    return all;
  }

  async getFlight(key: string, id: string): Promise<AirTrailFlight> {
    const r = await this.call<{ data?: AirTrailFlight }>(key, 'GET', `/api/v1/flights/${encodeURIComponent(id)}`);
    if (!r?.data) throw new AirTrailError(404, 'Flug nicht gefunden');
    return r.data;
  }

  async createFlight(key: string, body: FlightBody): Promise<string> {
    const r = await this.call<{ data?: { id?: string | number } }>(key, 'POST', '/api/v1/flights', body);
    const id = r?.data?.id;
    if (id === undefined || id === null) throw new AirTrailError(500, 'AirTrail hat keine Flug-ID geliefert');
    return String(id);
  }

  async updateFlight(key: string, id: string, body: FlightBody): Promise<void> {
    await this.call(key, 'PUT', `/api/v1/flights/${encodeURIComponent(id)}`, body);
  }

  async deleteFlight(key: string, id: string): Promise<void> {
    try {
      await this.call(key, 'DELETE', `/api/v1/flights/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err instanceof AirTrailError && err.status === 404) return;
      throw err;
    }
  }
}
