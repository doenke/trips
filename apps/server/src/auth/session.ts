import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomToken, sha256hex } from '../crypto.js';
import type { Db } from '../db/index.js';

export const SESSION_COOKIE = 'trips_sid';
const SESSION_DAYS = 90;
const DAY = 86_400_000;

/**
 * Browser session: a random id in a cookie signed with SESSION_KEY (HttpOnly, Secure, SameSite=Lax).
 * The server keeps only the hash, so logging out (or a stolen database) ends nothing more than that.
 */
export class Sessions {
  constructor(
    private readonly db: Db,
    private readonly secure: boolean,
  ) {}

  create(userId: string, reply: FastifyReply): void {
    const id = randomToken(32);
    const expires = Date.now() + SESSION_DAYS * DAY;
    this.db.run('INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256hex(id), userId, expires);
    this.setCookie(reply, id, expires);
  }

  private setCookie(reply: FastifyReply, id: string, expires: number): void {
    reply.setCookie(SESSION_COOKIE, id, { path: '/', httpOnly: true, secure: this.secure, sameSite: 'lax', signed: true, expires: new Date(expires) });
  }

  private cookieId(request: FastifyRequest): string | null {
    const raw = request.cookies[SESSION_COOKIE];
    if (!raw) return null;
    const u = request.unsignCookie(raw);
    return u.valid && u.value ? u.value : null;
  }

  /** The user of the current session; slides the expiry once a day. */
  userId(request: FastifyRequest, reply?: FastifyReply): string | null {
    const id = this.cookieId(request);
    if (!id) return null;
    const row = this.db.get<{ user_id: string; expires_at: number }>('SELECT user_id, expires_at FROM sessions WHERE id_hash = ?', sha256hex(id));
    if (!row || row.expires_at < Date.now()) return null;
    if (reply && row.expires_at - Date.now() < (SESSION_DAYS - 1) * DAY) {
      const expires = Date.now() + SESSION_DAYS * DAY;
      this.db.run('UPDATE sessions SET expires_at = ? WHERE id_hash = ?', expires, sha256hex(id));
      this.setCookie(reply, id, expires);
    }
    return row.user_id;
  }

  destroy(request: FastifyRequest, reply: FastifyReply): void {
    const id = this.cookieId(request);
    if (id) this.db.run('DELETE FROM sessions WHERE id_hash = ?', sha256hex(id));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  purgeExpired(): void {
    this.db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  }
}
