import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import sharp from 'sharp';
import type { UserService } from '../service/users.js';

const MAX_BYTES = 5 * 1024 * 1024;
export const AVATAR_SIZE = 128;

/**
 * Keeps a small local copy of the OIDC profile picture. The app never talks to the identity
 * provider for pictures: they work offline and don't reveal the provider's address.
 * Only https and only from the issuer host (or AVATAR_HOSTS) – no SSRF via a crafted "picture" claim.
 */
export class AvatarService {
  private readonly dir: string;
  private readonly hosts: Set<string>;

  constructor(
    dataDir: string,
    private readonly users: UserService,
    private readonly log: FastifyBaseLogger,
    opts: { issuer?: string; extraHosts?: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.dir = join(dataDir, 'avatars');
    mkdirSync(this.dir, { recursive: true });
    this.hosts = new Set((opts.extraHosts ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
    if (opts.issuer) {
      try {
        this.hosts.add(new URL(opts.issuer).hostname.toLowerCase());
      } catch {
        /* invalid issuer – no avatars */
      }
    }
  }

  allowed(url: string): boolean {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && this.hosts.has(u.hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  private async download(url: string, accessToken?: string): Promise<Buffer | null> {
    const get = (auth: boolean) =>
      this.fetchImpl(url, {
        headers: { accept: 'image/*', ...(auth && accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
    let res = await get(false);
    if ((res.status === 401 || res.status === 403) && accessToken) res = await get(true);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!/^image\/(png|jpeg|gif|webp)/.test(res.headers.get('content-type') ?? '')) throw new Error(`kein Bild: ${res.headers.get('content-type')}`);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_BYTES) throw new Error('Bild zu groß');
    return data;
  }

  /** After each login. Never fails the login: on errors the old picture stays. */
  async refresh(userId: string, url: string | null, accessToken?: string): Promise<void> {
    try {
      if (!url) return;
      if (!this.allowed(url)) {
        this.log.warn({ url }, 'Profilbild ignoriert: nur https vom Issuer-Host');
        return;
      }
      const raw = await this.download(url, accessToken);
      if (!raw) {
        this.users.setAvatar(userId, null);
        return;
      }
      const webp = await sharp(raw, { failOn: 'error' }).rotate().resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover' }).webp({ quality: 85 }).toBuffer();
      const version = createHash('sha1').update(webp).digest('hex').slice(0, 12);
      writeFileSync(join(this.dir, `${userId}.webp`), webp);
      this.users.setAvatar(userId, version);
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'Profilbild nicht übernommen');
    }
  }

  read(userId: string): Buffer | null {
    if (!/^[0-9a-f-]{36}$/.test(userId)) return null;
    try {
      return readFileSync(join(this.dir, `${userId}.webp`));
    } catch {
      return null;
    }
  }
}
