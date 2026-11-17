import { randomUUID } from 'node:crypto';
import { randomToken, sha256hex } from '../crypto.js';
import type { Db } from '../db/index.js';
import { notFound } from '../service/errors.js';

export const TOKEN_PREFIX = 'trp_';
const REFRESH_PREFIX = 'trr_';
export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_DAYS = 90;
const LAST_USED_GRANULARITY_MS = 5 * 60_000;

interface TokenRow {
  id: string;
  user_id: string;
  kind: 'pat' | 'oauth';
  name: string;
  client_id: string | null;
  prefix: string;
  expires_at: number | null;
  refresh_expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

export interface TokenInfo {
  id: string;
  kind: 'pat' | 'oauth';
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
}

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);

/** Personal API tokens and OAuth tokens (MCP clients). Only hashes are stored. */
export class Tokens {
  constructor(private readonly db: Db) {}

  /** Bearer token → its owner, or null. Updates "last used" now and then. */
  resolve(token: string): { userId: string; tokenId: string; name: string; kind: 'pat' | 'oauth' } | null {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const now = Date.now();
    const row = this.db.get<TokenRow>(
      'SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
      sha256hex(token),
      now,
    );
    if (!row) return null;
    if (!row.last_used_at || now - row.last_used_at > LAST_USED_GRANULARITY_MS) this.db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', now, row.id);
    return { userId: row.user_id, tokenId: row.id, name: row.name, kind: row.kind };
  }

  createPersonal(userId: string, name: string): { id: string; token: string } {
    const token = `${TOKEN_PREFIX}${randomToken(30)}`;
    const id = randomUUID();
    this.db.run(
      'INSERT INTO api_tokens (id, user_id, kind, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      userId,
      'pat',
      name,
      sha256hex(token),
      token.slice(0, 10),
      Date.now(),
    );
    return { id, token };
  }

  /** A new access + refresh token pair. With replaceId the old pair stops working (rotation). */
  issueOAuth(p: { userId: string; clientId: string; name: string; replaceId?: string }): { access: string; refresh: string } {
    const access = `${TOKEN_PREFIX}${randomToken(30)}`;
    const refresh = `${REFRESH_PREFIX}${randomToken(32)}`;
    const now = Date.now();
    const values = [sha256hex(access), access.slice(0, 10), sha256hex(refresh), now + ACCESS_TTL_S * 1000, now + REFRESH_TTL_DAYS * 86_400_000] as const;
    if (p.replaceId) {
      this.db.run(
        'UPDATE api_tokens SET token_hash = ?, prefix = ?, refresh_hash = ?, expires_at = ?, refresh_expires_at = ? WHERE id = ?',
        ...values,
        p.replaceId,
      );
    } else {
      this.db.run(
        'INSERT INTO api_tokens (id, user_id, kind, name, client_id, token_hash, prefix, refresh_hash, expires_at, refresh_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        randomUUID(),
        p.userId,
        'oauth',
        p.name,
        p.clientId,
        ...values,
        now,
      );
    }
    return { access, refresh };
  }

  byRefresh(refresh: string): TokenRow | undefined {
    return this.db.get<TokenRow>(
      'SELECT * FROM api_tokens WHERE refresh_hash = ? AND revoked_at IS NULL AND refresh_expires_at > ?',
      sha256hex(refresh),
      Date.now(),
    );
  }

  revokeByValue(token: string): void {
    const h = sha256hex(token);
    this.db.run('UPDATE api_tokens SET revoked_at = ? WHERE (token_hash = ? OR refresh_hash = ?) AND revoked_at IS NULL', Date.now(), h, h);
  }

  list(userId: string): TokenInfo[] {
    const now = Date.now();
    return this.db
      .all<TokenRow>('SELECT * FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC', userId)
      .filter((r) => r.kind === 'pat' || (r.refresh_expires_at ?? 0) > now)
      .map((r) => ({ id: r.id, kind: r.kind, name: r.name, prefix: r.prefix, created_at: iso(r.created_at)!, last_used_at: iso(r.last_used_at) }));
  }

  revoke(userId: string, id: string): void {
    const r = this.db.run('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', Date.now(), id, userId);
    if (!r.changes) throw notFound('Token');
  }
}
