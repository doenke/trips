import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeNext } from '../src/auth/oidc.js';
import { redirectRegistered, validRedirectUri } from '../src/oauth/routes.js';
import { createTestApp, PUBLIC_URL, type TestApp, textOf } from './helpers.js';

let t: TestApp;
let anna: Awaited<ReturnType<TestApp['login']>>;

beforeAll(async () => {
  t = await createTestApp();
  anna = await t.login('Anna');
  await t.app.inject({ method: 'POST', url: '/api/trips', headers: anna.headers, payload: { title: 'Kopenhagen', start_date: '2027-02-01', end_date: '2027-02-04' } });
});
afterAll(async () => t?.close());

const form = (data: Record<string, string>) => ({ headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(data).toString() });

describe('redirect URI rules', () => {
  it('accepts https anywhere and http only on loopback (any port)', () => {
    expect(validRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(validRedirectUri('https://example.org/cb?x=1')).toBe(true);
    expect(validRedirectUri('http://localhost:6274/oauth/callback')).toBe(true);
    expect(validRedirectUri('http://127.0.0.1:33418/callback')).toBe(true);
    expect(validRedirectUri('http://localhost/callback')).toBe(true);
    expect(validRedirectUri('http://evil.example/cb')).toBe(false);
    expect(validRedirectUri('https://claude.ai/cb#frag')).toBe(false);
    expect(validRedirectUri('javascript:alert(1)')).toBe(false);
    expect(validRedirectUri('nonsense')).toBe(false);
  });

  it('matches loopback URIs regardless of port', () => {
    expect(redirectRegistered(['http://127.0.0.1:1234/cb'], 'http://127.0.0.1:5555/cb')).toBe(true);
    expect(redirectRegistered(['http://127.0.0.1:1234/cb'], 'http://127.0.0.1:5555/other')).toBe(false);
    expect(redirectRegistered(['https://claude.ai/api/mcp/auth_callback'], 'https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(redirectRegistered(['https://claude.ai/api/mcp/auth_callback'], 'https://claude.ai/other')).toBe(false);
  });

  it('registers claude.ai without manual steps', async () => {
    const reg = await t.app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] } });
    expect(reg.statusCode).toBe(201);
    expect(reg.json()).toMatchObject({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' });
    const evil = await t.app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: ['http://evil.example/cb'] } });
    expect(evil.statusCode).toBe(400);
    expect(evil.json().error).toBe('invalid_redirect_uri');
  });

  it('only redirects to local paths after login', () => {
    expect(safeNext('/oauth/authorize?client_id=x&state=y')).toBe('/oauth/authorize?client_id=x&state=y');
    expect(safeNext('/trips/abc')).toBe('/trips/abc');
    expect(safeNext('//evil.example/x')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext(undefined)).toBe('/');
  });
});

describe('OAuth for MCP clients', () => {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const redirect = 'https://claude.ai/api/mcp/auth_callback';

  it('runs register → authorize → token → MCP → refresh → revoke', async () => {
    // Discovery
    const unauth = await t.app.inject({ method: 'POST', url: '/mcp', payload: {} });
    expect(unauth.statusCode).toBe(401);
    expect(unauth.headers['www-authenticate']).toContain(`resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`);
    expect((await t.app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' })).json()).toMatchObject({ resource: `${PUBLIC_URL}/mcp`, authorization_servers: [PUBLIC_URL] });
    expect((await t.app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json()).toMatchObject({
      registration_endpoint: `${PUBLIC_URL}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
    });

    const clientId = (await t.app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'Claude', redirect_uris: [redirect] } })).json().client_id;
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' });

    // Without a session: through the SSO login and back.
    const anon = await t.app.inject({ method: 'GET', url: `/oauth/authorize?${q}` });
    expect(anon.statusCode).toBe(302);
    expect(anon.headers.location).toBe(`/auth/login?next=${encodeURIComponent(`/oauth/authorize?${q}`)}`);

    // Unregistered redirect URI is refused.
    const wrong = await t.app.inject({ method: 'GET', url: `/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(q), redirect_uri: 'https://evil.example/cb' })}`, headers: anna.headers });
    expect(wrong.statusCode).toBe(400);

    // Consent page
    const consent = await t.app.inject({ method: 'GET', url: `/oauth/authorize?${q}`, headers: anna.headers });
    expect(consent.statusCode).toBe(200);
    expect(consent.body).toContain('„Claude“ möchte auf Trips zugreifen');
    expect(consent.body).toContain(redirect);
    expect(consent.body).toContain('Erlauben');
    expect(consent.body).toContain('Ablehnen');
    const csrf = /name="csrf" value="([^"]+)"/.exec(consent.body)![1]!;
    const csrfCookie = (consent.headers['set-cookie'] as string).split(';')[0]!;

    const allow = await t.app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      ...form({ ...Object.fromEntries(q), csrf, decision: 'allow' }),
      headers: { ...form({}).headers, cookie: `${anna.cookie}; ${csrfCookie}` },
    });
    expect(allow.statusCode).toBe(302);
    const back = new URL(allow.headers.location as string);
    expect(back.origin + back.pathname).toBe(redirect);
    expect(back.searchParams.get('state')).toBe('xyz');
    const code = back.searchParams.get('code')!;

    // Wrong verifier fails, and the code is single use.
    const bad = await t.app.inject({ method: 'POST', url: '/oauth/token', ...form({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirect, code_verifier: 'x'.repeat(43) }) });
    expect(bad.json().error).toBe('invalid_grant');

    // Fresh code, correct exchange.
    const consent2 = await t.app.inject({ method: 'GET', url: `/oauth/authorize?${q}`, headers: anna.headers });
    const csrf2 = /name="csrf" value="([^"]+)"/.exec(consent2.body)![1]!;
    const allow2 = await t.app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      payload: new URLSearchParams({ ...Object.fromEntries(q), csrf: csrf2, decision: 'allow' }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `${anna.cookie}; ${(consent2.headers['set-cookie'] as string).split(';')[0]}` },
    });
    const code2 = new URL(allow2.headers.location as string).searchParams.get('code')!;
    const tok = await t.app.inject({ method: 'POST', url: '/oauth/token', ...form({ grant_type: 'authorization_code', code: code2, client_id: clientId, redirect_uri: redirect, code_verifier: verifier }) });
    expect(tok.statusCode).toBe(200);
    const { access_token, refresh_token, expires_in } = tok.json();
    expect(expires_in).toBe(3600);

    // MCP call with the access token
    const client = await t.mcp(access_token);
    expect(textOf(await client.callTool({ name: 'list_trips', arguments: {} }))).toContain('Kopenhagen');
    await client.close();

    // Shows up under "Verbundene Apps"
    const apps = (await t.app.inject({ method: 'GET', url: '/api/tokens', headers: anna.headers })).json();
    const connected = apps.find((a: { kind: string }) => a.kind === 'oauth');
    expect(connected).toMatchObject({ name: 'Claude' });
    expect(connected.last_used_at).not.toBeNull();

    // Refresh rotates: the old refresh and access tokens stop working.
    const ref = await t.app.inject({ method: 'POST', url: '/oauth/token', ...form({ grant_type: 'refresh_token', refresh_token, client_id: clientId }) });
    expect(ref.statusCode).toBe(200);
    const fresh = ref.json();
    expect(fresh.refresh_token).not.toBe(refresh_token);
    expect((await t.app.inject({ method: 'POST', url: '/oauth/token', ...form({ grant_type: 'refresh_token', refresh_token, client_id: clientId }) })).json().error).toBe('invalid_grant');
    expect((await t.app.inject({ method: 'GET', url: '/api/trips', headers: { authorization: `Bearer ${access_token}` } })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/trips', headers: { authorization: `Bearer ${fresh.access_token}` } })).statusCode).toBe(200);

    // "Trennen" in the settings
    expect((await t.app.inject({ method: 'DELETE', url: `/api/tokens/${connected.id}`, headers: anna.headers })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/trips', headers: { authorization: `Bearer ${fresh.access_token}` } })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: '/oauth/token', ...form({ grant_type: 'refresh_token', refresh_token: fresh.refresh_token, client_id: clientId }) })).statusCode).toBe(400);
  });

  it('sends "deny" back as access_denied', async () => {
    const clientId = (await t.app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'Inspector', redirect_uris: ['http://localhost:6274/oauth/callback'] } })).json().client_id;
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'http://localhost:9999/oauth/callback', code_challenge: challenge, code_challenge_method: 'S256', state: 's1' });
    const consent = await t.app.inject({ method: 'GET', url: `/oauth/authorize?${q}`, headers: anna.headers });
    expect(consent.statusCode).toBe(200); // other loopback port is fine
    const csrf = /name="csrf" value="([^"]+)"/.exec(consent.body)![1]!;
    const deny = await t.app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      payload: new URLSearchParams({ ...Object.fromEntries(q), csrf, decision: 'deny' }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `${anna.cookie}; ${(consent.headers['set-cookie'] as string).split(';')[0]}` },
    });
    expect(deny.headers.location).toBe('http://localhost:9999/oauth/callback?error=access_denied&state=s1');
  });
});
