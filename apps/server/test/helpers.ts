import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp } from '../src/app.js';
import { testConfig } from '../src/config.js';
import type { Extraction, ExtractInput } from '../src/extract/claude.js';

export const PUBLIC_URL = 'https://trips.example.org';

/** A fake AirTrail (API v1) behind a mocked fetch. */
export class FakeAirTrail {
  flights = new Map<string, Record<string, unknown> & { owner: string }>();
  calls: { method: string; path: string; body?: unknown }[] = [];
  users: Record<string, { id: string; username: string }> = {
    'key-anna': { id: 'at-anna', username: 'anna' },
    'key-ben': { id: 'at-ben', username: 'ben' },
  };
  airports = [
    { id: 1, iata: 'DUS', icao: 'EDDL', timezone: 'Europe/Berlin' },
    { id: 2, iata: 'MUC', icao: 'EDDM', timezone: 'Europe/Berlin' },
    { id: 3, iata: 'JFK', icao: 'KJFK', timezone: 'America/New_York' },
    { id: 4, iata: 'PMI', icao: 'LEPA', timezone: 'Europe/Madrid' },
  ];
  airlines = [{ id: 10, iata: 'LH', icao: 'DLH' }];
  private next = 100;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path: url.pathname + url.search, body });
    const auth = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? '';
    const user = this.users[auth];
    const json = (status: number, data?: unknown) =>
      new Response(data === undefined ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (!user) return json(401, { message: 'Unauthorized' });
    const p = url.pathname;
    if (p === '/api/v1/me') return json(200, { data: { id: user.id, username: user.username } });
    if (p === '/api/v1/airports') {
      const q = url.searchParams.get('query')!.toUpperCase();
      return json(200, { data: this.airports.filter((a) => a.iata === q || a.icao === q) });
    }
    if (p === '/api/v1/airlines') {
      const q = url.searchParams.get('query')!.toUpperCase();
      return json(200, { data: this.airlines.filter((a) => a.iata === q || a.icao === q) });
    }
    if (p === '/api/v1/flights' && method === 'GET') {
      // Two pages, to exercise the cursor.
      const mine = [...this.flights.entries()].filter(([, f]) => this.visibleTo(f, user.id)).map(([id, f]) => this.dto(id, f));
      const start = Number(url.searchParams.get('cursor') ?? 0);
      const pageSize = 2;
      const next = start + pageSize < mine.length ? String(start + pageSize) : null;
      return json(200, { data: mine.slice(start, start + pageSize), page: { nextCursor: next } });
    }
    if (p === '/api/v1/flights' && method === 'POST') {
      const id = String(this.next++);
      this.flights.set(id, { ...body, owner: user.id });
      return json(201, { data: { id } });
    }
    const m = /^\/api\/v1\/flights\/(\w+)$/.exec(p);
    if (m) {
      const f = this.flights.get(m[1]!);
      if (!f || !this.visibleTo(f, user.id)) return json(404, { message: 'Not found' });
      if (method === 'GET') return json(200, { data: this.dto(m[1]!, f) });
      if (method === 'PUT') this.flights.set(m[1]!, { ...body, owner: user.id });
      if (method === 'DELETE') this.flights.delete(m[1]!);
      return new Response(null, { status: 204 });
    }
    return json(404, { message: 'nope' });
  };

  private visibleTo(f: Record<string, unknown> & { owner: string }, userId: string): boolean {
    return f.owner === userId || ((f.passengers as { userId: string | null }[]) ?? []).some((p) => p.userId === userId);
  }

  /** A stored flight as the API returns it. */
  dto(id: string, f: Record<string, unknown>) {
    const airport = (aid: unknown) => this.airports.find((a) => a.id === aid) ?? null;
    return {
      ...f,
      id: Number(id),
      from: airport(f.fromId),
      to: airport(f.toId),
      airline: f.airlineId ? { id: f.airlineId } : null,
      aircraft: f.aircraftId ? { id: f.aircraftId } : null,
      passengers: ((f.passengers as { userId: string | null; guestName?: string; seatNumber?: string }[]) ?? []).map((p, i) => ({
        id: i + 1,
        user: p.userId ? { id: p.userId } : null,
        guestName: p.guestName ?? null,
        seatNumber: p.seatNumber ?? null,
      })),
    };
  }

  /** A flight the user entered in AirTrail by hand (not from Trips). */
  addManual(owner: string, f: Record<string, unknown>): string {
    const id = String(this.next++);
    this.flights.set(id, { ...f, owner });
    return id;
  }

  count(method: string, prefix = '/api/v1/flights'): number {
    return this.calls.filter((c) => c.method === method && c.path.startsWith(prefix)).length;
  }
}

export interface Sent {
  to: string;
  subject: string;
  text: string;
}

export async function createTestApp(opts: { env?: Record<string, string>; extract?: (input: ExtractInput) => Extraction | Promise<Extraction> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'trips-test-'));
  const airtrail = new FakeAirTrail();
  const sent: Sent[] = [];
  const extractions: ExtractInput[] = [];
  let nextExtraction: Extraction | null = null;
  const config = testConfig({ DATA_DIR: dir, DEV_LOGIN: 'true', AIRTRAIL_URL: 'https://airtrail.example.org', PUBLIC_URL, ...opts.env });
  const { app, services } = await buildApp(config, {
    logger: false,
    fetch: airtrail.fetch,
    mailer: { send: async (m) => void sent.push(m) },
    extractor: async (input) => {
      extractions.push(input);
      if (opts.extract) return opts.extract(input);
      if (!nextExtraction) throw new Error('keine Test-Extraktion gesetzt');
      return nextExtraction;
    },
  });

  /** Logs in through DEV_LOGIN; returns the session cookie and the user. */
  const login = async (name: string, o: { admin?: boolean; email?: string } = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/dev',
      payload: { name, admin: !!o.admin, email: o.email ?? `${name.toLowerCase()}@example.org` },
    });
    if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
    const setCookie = res.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
    const cookie = raw.split(';')[0]!;
    const me = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
    return { cookie, id: me.user.id as string, headers: { cookie } };
  };

  let base: string | null = null;
  const listen = async () => (base ??= await app.listen({ port: 0, host: '127.0.0.1' }));

  const mcp = async (token: string) => {
    const url = await listen();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  };

  return {
    app,
    services,
    airtrail,
    sent,
    extractions,
    login,
    mcp,
    setExtraction: (e: Extraction) => {
      nextExtraction = e;
    },
    idle: () => services.airtrail.idle(),
    close: async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;

export const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? '';

/** A segment as the extractor returns it, all fields present. */
export function seg(p: Partial<Extraction['segments'][number]> & { type: Extraction['segments'][number]['type'] }): Extraction['segments'][number] {
  return {
    title: null,
    start_local: null,
    start_tz: null,
    end_local: null,
    end_tz: null,
    from_name: null,
    from_code: null,
    to_name: null,
    to_code: null,
    carrier: null,
    number: null,
    booking_ref: null,
    seat: null,
    address: null,
    notes: null,
    cancelled: false,
    documents: [],
    ...p,
  };
}

/** A raw RFC 822 mail. */
export function rawMail(p: {
  from: string;
  subject: string;
  text: string;
  messageId: string;
  authResults?: string;
  pdf?: Buffer;
  autoSubmitted?: string;
  to?: string;
  cc?: string;
}): string {
  const headers = [
    `From: ${p.from}`,
    `To: ${p.to ?? 'trips@example.org'}`,
    ...(p.cc ? [`Cc: ${p.cc}`] : []),
    `Subject: ${p.subject}`,
    `Message-ID: <${p.messageId}>`,
    'Date: Tue, 17 Nov 2026 10:00:00 +0100',
    'MIME-Version: 1.0',
    ...(p.authResults ? [`Authentication-Results: mx.example.org; ${p.authResults}`] : []),
    ...(p.autoSubmitted ? [`Auto-Submitted: ${p.autoSubmitted}`] : []),
  ];
  if (!p.pdf) return [...headers, 'Content-Type: text/plain; charset=utf-8', '', p.text, ''].join('\r\n');
  return [
    ...headers,
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    p.text,
    '--b1',
    'Content-Type: application/pdf; name="Buchung.pdf"',
    'Content-Disposition: attachment; filename="Buchung.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    p.pdf.toString('base64'),
    '--b1--',
    '',
  ].join('\r\n');
}
