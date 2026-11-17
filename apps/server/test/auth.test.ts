import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loginErrorCode } from '../src/auth/oidc.js';
import { createTestApp, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  // An issuer nobody answers for: discovery fails.
  t = await createTestApp({ env: { OIDC_ISSUER: 'https://127.0.0.1:1/', OIDC_CLIENT_ID: 'trips' } });
});
afterAll(async () => t?.close());

describe('login', () => {
  it('names the provider "Kanonenwiese SSO" and the callback URL', async () => {
    const cfg = (await t.app.inject({ method: 'GET', url: '/auth/config' })).json();
    expect(cfg).toMatchObject({ oidc: true, provider: 'Kanonenwiese SSO', redirectUri: 'https://trips.example.org/auth/callback', devLogin: true });
  });

  it('explains an unreachable provider instead of crashing', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/auth/login?next=/trips/x' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/?login_error=discovery&next=%2Ftrips%2Fx');
  });

  it('maps token endpoint errors', () => {
    expect(loginErrorCode({ error: 'invalid_client' })).toBe('invalid_client');
    expect(loginErrorCode({ error: 'invalid_grant' })).toBe('invalid_grant');
    expect(loginErrorCode(new Error('boom'))).toBe('failed');
  });

  it('expires an old login flow', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/auth/callback?code=x&state=y' });
    expect(res.headers.location).toBe('/?login_error=expired');
  });

  it('logs out', async () => {
    const anna = await t.login('Anna');
    expect((await t.app.inject({ method: 'POST', url: '/auth/logout', headers: anna.headers })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers: anna.headers })).statusCode).toBe(401);
  });
});

describe('avatars', () => {
  it('only mirrors https pictures from the issuer host, as 128px WebP', async () => {
    const { avatars } = t.services;
    expect(avatars.allowed('https://127.0.0.1/api/users/1/profile-picture.png')).toBe(true);
    expect(avatars.allowed('http://127.0.0.1/pic.png')).toBe(false);
    expect(avatars.allowed('https://evil.example/pic.png')).toBe(false);
    const anna = await t.login('Bea');
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#3366aa' } })
      .png()
      .toBuffer();
    const original = globalThis.fetch;
    const fetchImpl = (async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
    (avatars as unknown as { fetchImpl: typeof fetch }).fetchImpl = fetchImpl;
    await avatars.refresh(anna.id, 'https://127.0.0.1/api/users/1/profile-picture.png');
    globalThis.fetch = original;
    const me = (await t.app.inject({ method: 'GET', url: '/api/me', headers: anna.headers })).json();
    expect(me.user.avatar).toMatch(new RegExp(`^/avatar/${anna.id}\\?v=[0-9a-f]{12}$`));
    const img = await t.app.inject({ method: 'GET', url: me.user.avatar });
    expect(img.headers['content-type']).toBe('image/webp');
    expect(img.headers['cache-control']).toContain('immutable');
    const meta = await sharp(img.rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([128, 128]);
  });
});
