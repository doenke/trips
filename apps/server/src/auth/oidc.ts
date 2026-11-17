import type { FastifyInstance } from 'fastify';
import * as oidc from 'openid-client';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { UserService } from '../service/users.js';
import type { AvatarService } from './avatar.js';
import type { Sessions } from './session.js';

const FLOW_COOKIE = 'trips_oidc';

/** Only local paths as return target – no open redirects ("//evil.example", "/\\evil", "https://…"). */
export function safeNext(next: unknown): string {
  if (typeof next !== 'string' || next.length > 3000) return '/';
  if (!next.startsWith('/') || next.startsWith('//') || /[\\\s]/.test(next)) return '/';
  try {
    const u = new URL(next, 'http://local.invalid');
    return u.origin === 'http://local.invalid' ? `${u.pathname}${u.search}` : '/';
  } catch {
    return '/';
  }
}

/** Maps openid-client errors to the codes the login page explains. */
export function loginErrorCode(err: unknown): string {
  const e = err as { error?: string; code?: string; cause?: unknown };
  if (e?.error === 'invalid_client' || e?.error === 'unauthorized_client') return 'invalid_client';
  if (e?.error === 'invalid_grant') return 'invalid_grant';
  if (e?.code === 'OAUTH_INVALID_RESPONSE' && /state/i.test(String((err as Error).message))) return 'state';
  return 'failed';
}

export async function oidcRoutes(app: FastifyInstance, opts: { config: Config; users: UserService; sessions: Sessions; avatars: AvatarService }): Promise<void> {
  const { config, users, sessions, avatars } = opts;
  const secure = config.PUBLIC_URL.startsWith('https://');
  const redirectUri = `${config.PUBLIC_URL}/auth/callback`;

  let discovered: Promise<oidc.Configuration> | undefined;
  const oidcConfig = () => {
    if (!config.OIDC_ISSUER || !config.OIDC_CLIENT_ID) throw new Error('OIDC ist nicht konfiguriert');
    discovered ??= oidc
      .discovery(
        new URL(config.OIDC_ISSUER),
        config.OIDC_CLIENT_ID,
        config.OIDC_CLIENT_SECRET,
        config.OIDC_CLIENT_SECRET ? undefined : oidc.None(),
        config.OIDC_ISSUER.startsWith('http://') ? { execute: [oidc.allowInsecureRequests] } : undefined,
      )
      .catch((err) => {
        discovered = undefined;
        throw err;
      });
    return discovered;
  };

  app.get('/auth/config', async () => ({
    oidc: !!(config.OIDC_ISSUER && config.OIDC_CLIENT_ID),
    provider: config.OIDC_PROVIDER_NAME,
    devLogin: config.DEV_LOGIN,
    redirectUri,
  }));

  app.get('/auth/login', async (request, reply) => {
    const next = safeNext((request.query as Record<string, unknown>).next);
    let cfg: oidc.Configuration;
    try {
      cfg = await oidcConfig();
    } catch (err) {
      request.log.warn({ err: (err as Error).message }, 'OIDC-Discovery fehlgeschlagen');
      return reply.redirect(`/?login_error=discovery&next=${encodeURIComponent(next)}`);
    }
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const url = oidc.buildAuthorizationUrl(cfg, {
      redirect_uri: redirectUri,
      scope: config.OIDC_SCOPES,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    reply.setCookie(FLOW_COOKIE, JSON.stringify({ verifier, state, nonce, next }), { path: '/auth', httpOnly: true, sameSite: 'lax', secure, signed: true, maxAge: 600 });
    return reply.redirect(url.href);
  });

  app.get('/auth/callback', async (request, reply) => {
    const raw = request.cookies[FLOW_COOKIE];
    const unsigned = raw ? request.unsignCookie(raw) : undefined;
    reply.clearCookie(FLOW_COOKIE, { path: '/auth' });
    if (!unsigned?.valid || !unsigned.value) return reply.redirect('/?login_error=expired');
    const flow = JSON.parse(unsigned.value) as { verifier: string; state: string; nonce: string; next?: string };
    const query = request.query as Record<string, string | undefined>;
    if (query.error) {
      request.log.warn({ error: query.error, description: query.error_description }, 'OIDC-Provider meldet Fehler');
      return reply.redirect(`/?login_error=${encodeURIComponent(query.error === 'access_denied' ? 'access_denied' : 'provider')}`);
    }

    let cfg: oidc.Configuration;
    try {
      cfg = await oidcConfig();
    } catch {
      return reply.redirect('/?login_error=discovery');
    }
    const current = new URL(request.url, config.PUBLIC_URL);
    let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
    try {
      tokens = await oidc.authorizationCodeGrant(cfg, current, { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce });
    } catch (err) {
      request.log.warn({ err: (err as Error).message, code: loginErrorCode(err) }, 'OIDC-Callback fehlgeschlagen');
      return reply.redirect(`/?login_error=${loginErrorCode(err)}`);
    }
    let claims: Record<string, unknown> = { ...tokens.claims() };
    if (!claims.groups || !claims.email || !claims.picture || !claims.name) {
      const info = await oidc.fetchUserInfo(cfg, tokens.access_token, String(claims.sub)).catch(() => ({}));
      claims = { ...info, ...claims };
    }
    const groups = Array.isArray(claims.groups) ? claims.groups.map(String) : [];
    const picture = typeof claims.picture === 'string' ? claims.picture : null;
    const user = users.upsertFromLogin({
      sub: String(claims.sub),
      name: String(claims.name ?? claims.preferred_username ?? claims.email ?? 'Unbekannt'),
      email: typeof claims.email === 'string' ? claims.email : null,
      groups,
      isAdmin: groups.includes(config.OIDC_ADMIN_GROUP),
      avatarUrl: picture,
    });
    // In the background: the login doesn't wait for the picture.
    void avatars.refresh(user.id, picture, tokens.access_token);
    sessions.create(user.id, reply);
    return reply.redirect(safeNext(flow.next));
  });

  if (config.DEV_LOGIN) {
    app.log.warn('DEV_LOGIN ist aktiv – Anmeldung nur mit Namen möglich. NIE IN PRODUKTION VERWENDEN!');
    app.post('/auth/dev', async (request, reply) => {
      const body = z
        .object({ name: z.string().trim().min(1).max(60), email: z.string().email().optional(), admin: z.boolean().default(false) })
        .parse(request.body);
      const user = users.upsertFromLogin({
        sub: `dev:${body.name.toLowerCase()}`,
        name: body.name,
        email: body.email ?? null,
        groups: body.admin ? [config.OIDC_ADMIN_GROUP] : [],
        isAdmin: body.admin,
        avatarUrl: null,
      });
      sessions.create(user.id, reply);
      return { ok: true };
    });
  }

  app.post('/auth/logout', async (request, reply) => {
    sessions.destroy(request, reply);
    return { ok: true };
  });
}
