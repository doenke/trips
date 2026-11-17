import { accessSync, constants, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { createAirTrail, type AirTrailSync } from './airtrail/sync.js';
import { apiRoutes } from './api/routes.js';
import { AvatarService } from './auth/avatar.js';
import { oidcRoutes } from './auth/oidc.js';
import { Sessions } from './auth/session.js';
import { Tokens } from './auth/tokens.js';
import type { Config } from './config.js';
import { Keys } from './crypto.js';
import { Db } from './db/index.js';
import { claudeExtractor, type Extractor } from './extract/claude.js';
import { buildIcs } from './ics.js';
import { createMailer, type Mailer } from './mail/notify.js';
import { MailProcessor } from './mail/processor.js';
import { mcpRoutes, zodMessage } from './mcp/server.js';
import { oauthRoutes } from './oauth/routes.js';
import { AttachmentService } from './service/attachments.js';
import { BookingService } from './service/booking.js';
import { type Actor, AppError } from './service/errors.js';
import { ExchangeService } from './service/exchange.js';
import { TripService } from './service/trips.js';
import { UserService } from './service/users.js';

export interface Principal {
  userId: string;
  actor: Actor;
  via: 'session' | 'token';
  tokenName?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface Services {
  config: Config;
  db: Db;
  keys: Keys;
  users: UserService;
  trips: TripService;
  attachments: AttachmentService;
  booking: BookingService;
  exchange: ExchangeService;
  airtrail: AirTrailSync;
  sessions: Sessions;
  tokens: Tokens;
  avatars: AvatarService;
  mail: MailProcessor;
  log: FastifyBaseLogger;
}

export interface Deps {
  /** For AirTrail and avatars (tests pass a mock). */
  fetch?: typeof fetch;
  extractor?: Extractor | null;
  mailer?: Mailer | null;
  logger?: boolean;
}

export async function buildApp(config: Config, deps: Deps = {}): Promise<{ app: FastifyInstance; services: Services }> {
  const app = Fastify({
    logger: deps.logger === false ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: config.TRUSTED_PROXY,
    bodyLimit: 30 * 1024 * 1024,
  });

  const dataDir = resolve(config.DATA_DIR);
  const db = new Db(config.DATA_DIR === ':memory:' ? ':memory:' : join(dataDir, 'trips.db'));
  const keys = new Keys(config.SESSION_KEY);
  const users = new UserService(db, keys);
  const trips = new TripService(db, { graceDays: config.TRIP_MATCH_DAYS, timeZone: process.env.TZ || 'Europe/Berlin' });
  const filesDir = config.DATA_DIR === ':memory:' ? join(process.cwd(), '.test-data') : dataDir;
  const attachments = new AttachmentService(db, trips, filesDir);
  const extractor = deps.extractor !== undefined ? deps.extractor : config.ANTHROPIC_API_KEY ? claudeExtractor({ apiKey: config.ANTHROPIC_API_KEY, model: config.ANTHROPIC_MODEL }) : null;
  const booking = new BookingService(trips, users, attachments, extractor, { publicUrl: config.PUBLIC_URL, timeZone: process.env.TZ || 'Europe/Berlin' });
  const airtrail = createAirTrail(config.AIRTRAIL_URL, trips, users, app.log, deps.fetch);
  trips.hooks = airtrail;
  const secure = config.PUBLIC_URL.startsWith('https://');
  const services: Services = {
    config,
    db,
    keys,
    users,
    trips,
    attachments,
    booking,
    exchange: new ExchangeService(trips, users),
    airtrail,
    sessions: new Sessions(db, secure),
    tokens: new Tokens(db),
    avatars: new AvatarService(filesDir, users, app.log, { issuer: config.OIDC_ISSUER, extraHosts: config.AVATAR_HOSTS }, deps.fetch),
    mail: new MailProcessor(db, users, booking, deps.mailer !== undefined ? deps.mailer : createMailer(config), app.log, {
      requireDmarcPass: config.MAIL_REQUIRE_DMARC_PASS,
      publicUrl: config.PUBLIC_URL,
    }),
    log: app.log,
  };
  app.addHook('onClose', async () => {
    await airtrail.idle();
    db.close();
  });

  await app.register(fastifyCookie, { secret: config.SESSION_KEY });
  await app.register(fastifyMultipart, { limits: { fileSize: 20 * 1024 * 1024, files: 5, fields: 10 } });

  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: 'bad_request', message: zodMessage(err) });
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'too_large', message: 'Die Datei ist zu groß (höchstens 20 MB).' });
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: 'bad_request', message: e.message });
    request.log.error({ err }, 'Unerwarteter Fehler');
    return reply.code(500).send({ error: 'internal', message: 'Da ist etwas schiefgegangen.' });
  });

  // ---- who is asking ---------------------------------------------------------------------

  const sessionUser = (request: FastifyRequest) => services.sessions.userId(request);

  const resolvePrincipal = (request: FastifyRequest, reply: FastifyReply): Principal | null => {
    const auth = request.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const t = services.tokens.resolve(auth.slice(7).trim());
      if (!t) return null;
      const u = users.get(t.userId);
      return u ? { userId: u.id, actor: { userId: u.id, isAdmin: !!u.is_admin }, via: 'token', tokenName: t.name } : null;
    }
    const id = services.sessions.userId(request, reply);
    const u = id ? users.get(id) : undefined;
    return u ? { userId: u.id, actor: { userId: u.id, isAdmin: !!u.is_admin }, via: 'session' } : null;
  };

  const requireUser = async (request: FastifyRequest, reply: FastifyReply) => {
    const p = resolvePrincipal(request, reply);
    if (!p) {
      // Tells OAuth clients (MCP) where to find out how to log in.
      reply.header('WWW-Authenticate', `Bearer resource_metadata="${config.PUBLIC_URL}/.well-known/oauth-protected-resource"`);
      throw new AppError(401, 'unauthorized', 'Bitte anmelden oder ein gültiges Token mitschicken.');
    }
    request.principal = p;
  };

  // ---- routes --------------------------------------------------------------------------------

  app.get('/healthz', async (_request, reply) => {
    const checks: Record<string, string> = {};
    try {
      db.get('SELECT 1');
      checks.db = 'ok';
    } catch {
      checks.db = 'error';
    }
    try {
      accessSync(filesDir, constants.W_OK);
      checks.data = 'ok';
    } catch {
      checks.data = 'error';
    }
    const ok = Object.values(checks).every((v) => v === 'ok');
    return reply
      .code(ok ? 200 : 503)
      .header('Cache-Control', 'no-store')
      .send({ status: ok ? 'ok' : 'error', version: config.APP_VERSION, checks });
  });

  app.get('/robots.txt', async (_request, reply) => reply.type('text/plain').send('User-agent: *\nDisallow: /\n'));

  app.get('/avatar/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const data = services.avatars.read(id);
    if (!data) return reply.code(404).send({ error: 'not_found', message: 'Kein Profilbild' });
    return reply.type('image/webp').header('Cache-Control', 'public, max-age=31536000, immutable').send(data);
  });

  app.get('/ics/:file', async (request, reply) => {
    const { file } = request.params as { file: string };
    const user = file.endsWith('.ics') ? users.userForIcsToken(file.slice(0, -4)) : undefined;
    if (!user) return reply.code(404).type('text/plain').send('Unbekannter Kalender-Link');
    const actor = { userId: user.id, isAdmin: !!user.is_admin };
    const list = trips.listTrips(actor, { filter: 'all', mine: true }).map((t) => trips.getTrip(actor, t.id));
    return reply
      .type('text/calendar; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(buildIcs(list, { publicUrl: config.PUBLIC_URL, calendarName: `Trips – ${user.name}` }));
  });

  await app.register(oidcRoutes, { config, users, sessions: services.sessions, avatars: services.avatars });
  await app.register(oauthRoutes, { config, db, tokens: services.tokens, sessionUser });
  await app.register(mcpRoutes, { services, requireUser });
  await app.register(apiRoutes, { services, requireUser });

  // ---- the PWA ---------------------------------------------------------------------------------

  const webDist = config.WEB_DIST ? resolve(config.WEB_DIST) : resolve(process.cwd(), '../web/dist');
  if (existsSync(join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      setHeaders(reply, path) {
        // Hashed assets forever; everything else (index.html, sw.js, manifest) always fresh.
        reply.header('Cache-Control', /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }
  app.setNotFoundHandler((request, reply) => {
    // App routes (/trips/…, /settings) get the shell; missing files (with an extension) stay 404.
    const path = request.url.split('?')[0]!;
    if (request.method === 'GET' && !/^\/(api|auth|oauth|mcp|ics|avatar|healthz)/.test(path) && !/\.[a-z0-9]+$/i.test(path) && existsSync(join(webDist, 'index.html'))) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found', message: 'Nicht gefunden' });
  });

  return { app, services };
}
