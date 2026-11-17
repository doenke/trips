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
  departure?: string;
  arrival?: string;
  fromId: number | string;
  toId: number | string;
  airlineId?: number | string;
  flightNumber?: string;
  note?: string;
  passengers: { userId: string; seatNumber?: string }[];
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
