import { randomUUID } from 'node:crypto';
import type { Keys } from '../crypto.js';
import { randomToken } from '../crypto.js';
import type { Db } from '../db/index.js';
import { type Actor, AppError, badRequest, conflict, notFound } from './errors.js';

export interface UserRow {
  id: string;
  sub: string;
  name: string;
  email: string | null;
  groups: string;
  is_admin: number;
  avatar_url: string | null;
  avatar_version: string | null;
  ics_nonce: string;
  airtrail_key: string | null;
  airtrail_user_id: string | null;
  airtrail_status: string | null;
}

export interface PublicUser {
  id: string;
  name: string;
  email: string | null;
  avatar: string | null;
  is_admin: boolean;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function avatarUrl(u: Pick<UserRow, 'id' | 'avatar_version'>): string | null {
  return u.avatar_version ? `/avatar/${u.id}?v=${u.avatar_version}` : null;
}

export function publicUser(u: UserRow): PublicUser {
  return { id: u.id, name: u.name, email: u.email, avatar: avatarUrl(u), is_admin: !!u.is_admin };
}

export class UserService {
  constructor(
    private readonly db: Db,
    private readonly keys: Keys,
  ) {}

  /** Called on every OIDC login: name, email, groups and admin flag follow the provider. */
  upsertFromLogin(p: { sub: string; name: string; email: string | null; groups: string[]; isAdmin: boolean; avatarUrl: string | null }): UserRow {
    return this.db.tx(() => {
      const email = p.email ? normalizeEmail(p.email) : null;
      const existing = this.db.get<UserRow>('SELECT * FROM users WHERE sub = ?', p.sub);
      // A login email that is someone else's (login or alternative) address is not taken over.
      const clash = email && this.ownerOfEmail(email);
      const safeEmail = clash && clash.sub !== p.sub ? null : email;
      if (existing) {
        this.db.run(
          `UPDATE users SET name = ?, email = ?, groups = ?, is_admin = ?, avatar_url = ?, last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
          p.name,
          safeEmail,
          JSON.stringify(p.groups),
          p.isAdmin ? 1 : 0,
          p.avatarUrl,
          existing.id,
        );
        // The login address is no longer needed as alternative address.
        if (safeEmail) this.db.run('DELETE FROM user_emails WHERE email = ? AND user_id = ?', safeEmail, existing.id);
        return this.require(existing.id);
      }
      const id = randomUUID();
      this.db.run(
        `INSERT INTO users (id, sub, name, email, groups, is_admin, avatar_url, ics_nonce, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        id,
        p.sub,
        p.name,
        safeEmail,
        JSON.stringify(p.groups),
        p.isAdmin ? 1 : 0,
        p.avatarUrl,
        randomToken(9),
      );
      return this.require(id);
    });
  }

  get(id: string): UserRow | undefined {
    return this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
  }

  require(id: string): UserRow {
    const u = this.get(id);
    if (!u) throw notFound('Benutzer');
    return u;
  }

  actor(id: string): Actor {
    const u = this.require(id);
    return { userId: u.id, isAdmin: !!u.is_admin };
  }

  list(): UserRow[] {
    return this.db.all<UserRow>('SELECT * FROM users ORDER BY name COLLATE NOCASE');
  }

  /** The account an address belongs to: login email or an alternative address. */
  ownerOfEmail(email: string): UserRow | undefined {
    const e = normalizeEmail(email);
    return (
      this.db.get<UserRow>('SELECT * FROM users WHERE lower(email) = ?', e) ??
      this.db.get<UserRow>('SELECT u.* FROM user_emails a JOIN users u ON u.id = a.user_id WHERE a.email = ?', e)
    );
  }

  altEmails(userId: string): string[] {
    return this.db.all<{ email: string }>('SELECT email FROM user_emails WHERE user_id = ? ORDER BY email', userId).map((r) => r.email);
  }

  addAltEmail(userId: string, raw: string): string[] {
    const email = normalizeEmail(raw);
    if (!EMAIL_RE.test(email) || email.length > 200) throw badRequest('Das sieht nicht nach einer E-Mail-Adresse aus.');
    const owner = this.ownerOfEmail(email);
    if (owner?.id === userId) throw conflict('Diese Adresse gehört schon zu deinem Konto.');
    if (owner) throw conflict('Diese Adresse ist bereits einem anderen Konto zugeordnet. Eine Adresse kann nur zu einem Konto gehören.');
    this.db.run('INSERT INTO user_emails (email, user_id) VALUES (?, ?)', email, userId);
    return this.altEmails(userId);
  }

  removeAltEmail(userId: string, raw: string): string[] {
    const r = this.db.run('DELETE FROM user_emails WHERE email = ? AND user_id = ?', normalizeEmail(raw), userId);
    if (!r.changes) throw notFound('Adresse');
    return this.altEmails(userId);
  }

  // ---- ICS feed token: "<userId>.<hmac(userId:nonce)>" – nothing secret stored.

  icsToken(userId: string): string {
    const u = this.require(userId);
    return `${u.id}.${this.keys.sign(`ics:${u.id}:${u.ics_nonce}`)}`;
  }

  rotateIcsToken(userId: string): string {
    this.db.run('UPDATE users SET ics_nonce = ? WHERE id = ?', randomToken(9), userId);
    return this.icsToken(userId);
  }

  userForIcsToken(token: string): UserRow | undefined {
    const dot = token.indexOf('.');
    if (dot < 1) return undefined;
    const u = this.get(token.slice(0, dot));
    return u && this.keys.verify(`ics:${u.id}:${u.ics_nonce}`, token.slice(dot + 1)) ? u : undefined;
  }

  // ---- AirTrail key (encrypted at rest)

  airtrailKey(userId: string): string | null {
    const u = this.get(userId);
    if (!u?.airtrail_key) return null;
    try {
      return this.keys.decrypt(u.airtrail_key);
    } catch {
      return null;
    }
  }

  setAirtrail(userId: string, key: string | null, airtrailUserId: string | null, status: string | null): void {
    this.db.run(
      'UPDATE users SET airtrail_key = ?, airtrail_user_id = ?, airtrail_status = ? WHERE id = ?',
      key ? this.keys.encrypt(key) : null,
      airtrailUserId,
      status,
      userId,
    );
  }

  setAirtrailStatus(userId: string, status: string | null): void {
    this.db.run('UPDATE users SET airtrail_status = ? WHERE id = ?', status, userId);
  }

  setAvatar(userId: string, version: string | null): void {
    this.db.run('UPDATE users SET avatar_version = ? WHERE id = ?', version, userId);
  }
}

export function assertAdmin(actor: Actor): void {
  if (!actor.isAdmin) throw new AppError(403, 'admin_only', 'Das dürfen nur Admins.');
}
