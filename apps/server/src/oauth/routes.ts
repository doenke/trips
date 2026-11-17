import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ACCESS_TTL_S, type Tokens } from '../auth/tokens.js';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';

/**
 * OAuth 2.1 authorization server for MCP clients (Claude & co.): dynamic client registration,
 * authorization code + PKCE (S256), rotating refresh tokens. The user logs in with the normal
 * SSO session and confirms on a small consent page.
 */

const CODE_TTL_MS = 10 * 60_000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

interface PendingCode {
  clientId: string;
  userId: string;
  redirectUri: string;
  challenge: string;
  expiresAt: number;
}

interface ClientRow {
  id: string;
  name: string;
  redirect_uris: string;
}

/** Any https URI (e.g. https://claude.ai/api/mcp/auth_callback); plain http only on loopback, any port. */
export function validRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash || u.username || u.password) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && LOOPBACK.has(u.hostname);
  } catch {
    return false;
  }
}

/** Exact match; loopback URIs match on any port (RFC 8252: native apps pick a free port at runtime). */
export function redirectRegistered(registered: string[], uri: string): boolean {
  if (registered.includes(uri)) return true;
  try {
    const u = new URL(uri);
    if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname)) return false;
    return registered.some((r) => {
      const x = new URL(r);
      return x.protocol === 'http:' && x.hostname === u.hostname && x.pathname === u.pathname;
    });
  } catch {
    return false;
  }
}

function sha256url(s: string): string {
  return createHash('sha256').update(s).digest('base64url');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export async function oauthRoutes(
  app: FastifyInstance,
  opts: { config: Config; db: Db; tokens: Tokens; sessionUser: (req: import('fastify').FastifyRequest) => string | null },
): Promise<void> {
  const { config, db, tokens } = opts;
  const base = config.PUBLIC_URL;
  const secure = base.startsWith('https://');
  const codes = new Map<string, PendingCode>();
  const sweep = setInterval(() => {
    for (const [k, v] of codes) if (v.expiresAt < Date.now()) codes.delete(k);
  }, 60_000);
  sweep.unref();
  app.addHook('onClose', async () => clearInterval(sweep));

  // OAuth endpoints speak application/x-www-form-urlencoded.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });

  // ---- discovery --------------------------------------------------------------------

  const resourceMetadata = {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    resource_name: 'Trips',
  };
  app.get('/.well-known/oauth-protected-resource', async () => resourceMetadata);
  app.get('/.well-known/oauth-protected-resource/mcp', async () => resourceMetadata);

  const serverMetadata = {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['trips'],
  };
  app.get('/.well-known/oauth-authorization-server', async () => serverMetadata);
  app.get('/.well-known/oauth-authorization-server/mcp', async () => serverMetadata);

  // ---- dynamic client registration (RFC 7591) ---------------------------------------

  app.post('/oauth/register', async (request, reply) => {
    const body = z
      .object({ client_name: z.string().max(100).optional(), redirect_uris: z.array(z.string().max(2000)).min(1).max(10) })
      .passthrough()
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_client_metadata', error_description: 'redirect_uris fehlen' });
    const bad = body.data.redirect_uris.filter((u) => !validRedirectUri(u));
    if (bad.length) {
      return reply.code(400).send({
        error: 'invalid_redirect_uri',
        error_description: `Nicht erlaubt: ${bad.join(', ')} – erlaubt sind https-Adressen und http://localhost bzw. http://127.0.0.1 mit beliebigem Port.`,
      });
    }
    const id = `mcp_${randomBytes(16).toString('base64url')}`;
    const name = body.data.client_name?.trim() || 'KI-Assistent';
    db.run('INSERT INTO oauth_clients (id, name, redirect_uris) VALUES (?, ?, ?)', id, name, JSON.stringify(body.data.redirect_uris));
    return reply.code(201).send({
      client_id: id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: body.data.redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  // ---- authorization ------------------------------------------------------------------

  const AuthorizeQuery = z.object({
    response_type: z.literal('code'),
    client_id: z.string().min(1),
    redirect_uri: z.string(),
    code_challenge: z.string().min(43).max(128),
    code_challenge_method: z.literal('S256'),
    state: z.string().max(1000).optional(),
    scope: z.string().max(200).optional(),
    resource: z.string().optional(),
  });

  const client = (id: string) => {
    const row = db.get<ClientRow>('SELECT * FROM oauth_clients WHERE id = ?', id);
    return row ? { ...row, redirectUris: JSON.parse(row.redirect_uris) as string[] } : undefined;
  };

  const page = (reply: FastifyReply, status: number, title: string, body: string) =>
    reply
      .code(status)
      .type('text/html; charset=utf-8')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*")
      .header('X-Frame-Options', 'DENY')
      .header('Cache-Control', 'no-store')
      .send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} – Trips</title><style>
:root{color-scheme:light dark}
body{font-family:system-ui,sans-serif;background:#f4f2ee;color:#1d2226;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}
main{background:#fff;border:1px solid #e0dcd4;border-radius:18px;padding:24px;max-width:440px;width:100%;box-sizing:border-box}
h1{font-size:1.25rem;margin:0 0 12px}p{line-height:1.5}code{word-break:break-all;font-size:.85rem;background:rgba(127,127,127,.12);padding:2px 5px;border-radius:5px}
button{min-height:44px;padding:0 20px;border-radius:12px;border:1px solid #d6d1c7;background:transparent;color:inherit;font:inherit;cursor:pointer}
.primary{background:#1f5f8b;border-color:#1f5f8b;color:#fff;font-weight:600}.row{display:flex;gap:8px;justify-content:flex-end;margin-top:22px}.muted{color:#6b7175;font-size:.9rem}
@media (prefers-color-scheme:dark){body{background:#121517;color:#e6e9eb}main{background:#1b1f22;border-color:#2c3236}button{border-color:#3a4146}}
</style></head><body><main>${body}</main></body></html>`);

  const fail = (reply: FastifyReply, message: string) => page(reply, 400, 'Fehler', `<h1>Das hat nicht geklappt</h1><p>${escapeHtml(message)}</p>`);

  const redirectWith = (uri: string, params: Record<string, string | undefined>) => {
    const u = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    return u.toString();
  };

  app.get('/oauth/authorize', async (request, reply) => {
    const q = AuthorizeQuery.safeParse(request.query);
    if (!q.success) return fail(reply, 'Unvollständige Anfrage (Authorization Code mit PKCE/S256 ist Pflicht).');
    const c = client(q.data.client_id);
    if (!c) return fail(reply, 'Unbekannte App. Bitte die Verbindung in der App neu einrichten.');
    if (!redirectRegistered(c.redirectUris, q.data.redirect_uri))
      return fail(reply, `Diese Rücksprungadresse ist für „${c.name}“ nicht registriert: ${q.data.redirect_uri}`);

    const userId = opts.sessionUser(request);
    if (!userId) {
      // Log in through SSO first, then come back here.
      return reply.redirect(`/auth/login?next=${encodeURIComponent(request.url)}`);
    }
    const csrf = randomBytes(16).toString('base64url');
    reply.setCookie('trips_oauth_csrf', csrf, { path: '/oauth', httpOnly: true, sameSite: 'strict', secure, signed: true, maxAge: 600 });
    const hidden = Object.entries({ ...q.data, csrf })
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(String(v))}">`)
      .join('');
    return page(
      reply,
      200,
      'Zugriff erlauben',
      `<h1>„${escapeHtml(c.name)}“ möchte auf Trips zugreifen</h1>
<p>Die App kann dann in deinem Namen Reisen lesen, anlegen und ändern – mit denselben Rechten wie du in der App.</p>
<p class="muted">Rücksprung an <code>${escapeHtml(q.data.redirect_uri)}</code></p>
<p class="muted">Du kannst die Verbindung jederzeit unter Einstellungen → Verbundene Apps trennen.</p>
<form method="post" action="/oauth/authorize">${hidden}<div class="row">
<button name="decision" value="deny">Ablehnen</button><button class="primary" name="decision" value="allow">Erlauben</button></div></form>`,
    );
  });

  app.post('/oauth/authorize', async (request, reply) => {
    const body = AuthorizeQuery.extend({ csrf: z.string(), decision: z.enum(['allow', 'deny']) }).safeParse(request.body);
    if (!body.success) return fail(reply, 'Ungültige Anfrage.');
    const cookie = request.cookies.trips_oauth_csrf ? request.unsignCookie(request.cookies.trips_oauth_csrf) : undefined;
    if (!cookie?.valid || cookie.value !== body.data.csrf) return fail(reply, 'Sitzung abgelaufen, bitte noch einmal versuchen.');
    reply.clearCookie('trips_oauth_csrf', { path: '/oauth' });
    const c = client(body.data.client_id);
    if (!c || !redirectRegistered(c.redirectUris, body.data.redirect_uri)) return fail(reply, 'Unbekannte App.');
    const userId = opts.sessionUser(request);
    if (!userId) return fail(reply, 'Nicht angemeldet.');
    if (body.data.decision === 'deny') return reply.redirect(redirectWith(body.data.redirect_uri, { error: 'access_denied', state: body.data.state }));
    const code = randomBytes(32).toString('base64url');
    codes.set(code, { clientId: c.id, userId, redirectUri: body.data.redirect_uri, challenge: body.data.code_challenge, expiresAt: Date.now() + CODE_TTL_MS });
    return reply.redirect(redirectWith(body.data.redirect_uri, { code, state: body.data.state, iss: base }));
  });

  // ---- tokens -------------------------------------------------------------------------

  const tokenError = (reply: FastifyReply, error: string, description: string, status = 400) =>
    reply.code(status).header('Cache-Control', 'no-store').send({ error, error_description: description });

  const issue = (reply: FastifyReply, p: { userId: string; clientId: string; name: string; replaceId?: string }) => {
    const t = tokens.issueOAuth(p);
    return reply
      .header('Cache-Control', 'no-store')
      .send({ access_token: t.access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: t.refresh, scope: 'trips' });
  };

  app.post('/oauth/token', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string | undefined>;
    if (body.grant_type === 'authorization_code') {
      const pending = body.code ? codes.get(body.code) : undefined;
      if (body.code) codes.delete(body.code); // single use
      if (!pending || pending.expiresAt < Date.now()) return tokenError(reply, 'invalid_grant', 'Code ungültig oder abgelaufen');
      if (pending.clientId !== body.client_id || pending.redirectUri !== body.redirect_uri)
        return tokenError(reply, 'invalid_grant', 'Client oder Rücksprungadresse passt nicht');
      if (!body.code_verifier || sha256url(body.code_verifier) !== pending.challenge) return tokenError(reply, 'invalid_grant', 'PKCE-Prüfung fehlgeschlagen');
      const c = client(pending.clientId);
      return issue(reply, { userId: pending.userId, clientId: pending.clientId, name: c?.name ?? 'KI-Assistent' });
    }
    if (body.grant_type === 'refresh_token') {
      if (!body.refresh_token) return tokenError(reply, 'invalid_request', 'refresh_token fehlt');
      const row = tokens.byRefresh(body.refresh_token);
      if (!row || (body.client_id && row.client_id !== body.client_id)) return tokenError(reply, 'invalid_grant', 'Refresh-Token ungültig');
      // Rotation: the old refresh token stops working.
      return issue(reply, { userId: row.user_id, clientId: row.client_id!, name: row.name, replaceId: row.id });
    }
    return tokenError(reply, 'unsupported_grant_type', 'Nur authorization_code und refresh_token');
  });

  app.post('/oauth/revoke', async (request, reply) => {
    const token = ((request.body ?? {}) as Record<string, string | undefined>).token;
    if (token) tokens.revokeByValue(token);
    return reply.code(200).send({});
  });
}
