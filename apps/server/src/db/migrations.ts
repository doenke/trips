/** Schema migrations, applied in order (PRAGMA user_version). Never edit a released entry – append. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    sub TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    email TEXT,
    groups TEXT NOT NULL DEFAULT '[]',
    is_admin INTEGER NOT NULL DEFAULT 0,
    avatar_url TEXT,
    avatar_version TEXT,
    ics_nonce TEXT NOT NULL,
    airtrail_key TEXT,
    airtrail_user_id TEXT,
    airtrail_status TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_login_at TEXT
  );
  CREATE UNIQUE INDEX users_email ON users(lower(email)) WHERE email IS NOT NULL;

  CREATE TABLE user_emails (
    email TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE trips (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    destination TEXT,
    start_date TEXT,
    end_date TEXT,
    notes TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE trip_travelers (
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (trip_id, user_id)
  );
  CREATE INDEX trip_travelers_user ON trip_travelers(user_id);

  CREATE TABLE segments (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    start_local TEXT,
    start_tz TEXT,
    end_local TEXT,
    end_tz TEXT,
    from_name TEXT,
    from_code TEXT,
    to_name TEXT,
    to_code TEXT,
    carrier TEXT,
    number TEXT,
    booking_ref TEXT,
    seat TEXT,
    address TEXT,
    notes TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    airtrail_ids TEXT NOT NULL DEFAULT '{}',
    airtrail_error TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX segments_trip ON segments(trip_id);

  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    segment_id TEXT REFERENCES segments(id) ON DELETE SET NULL,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX attachments_trip ON attachments(trip_id);

  CREATE TABLE mail_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL UNIQUE,
    sender TEXT,
    subject TEXT,
    status TEXT NOT NULL,
    detail TEXT,
    trip_id TEXT REFERENCES trips(id) ON DELETE SET NULL,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE oauth_clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    client_id TEXT REFERENCES oauth_clients(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    refresh_hash TEXT UNIQUE,
    expires_at INTEGER,
    refresh_expires_at INTEGER,
    last_used_at INTEGER,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX api_tokens_user ON api_tokens(user_id);
  `,
  // 2: an attachment can belong to several segments (an e-ticket for outbound and return flight).
  `
  CREATE TABLE attachment_segments (
    attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    PRIMARY KEY (attachment_id, segment_id)
  );
  CREATE INDEX attachment_segments_segment ON attachment_segments(segment_id);
  INSERT INTO attachment_segments (attachment_id, segment_id)
    SELECT id, segment_id FROM attachments WHERE segment_id IS NOT NULL AND segment_id IN (SELECT id FROM segments);
  -- Attachments that came with an import but hung on the whole trip: link them to the segments
  -- created or updated in the same import (within ten seconds, same trip).
  INSERT OR IGNORE INTO attachment_segments (attachment_id, segment_id)
    SELECT a.id, s.id FROM attachments a JOIN segments s ON s.trip_id = a.trip_id
    WHERE a.segment_id IS NULL
      AND (abs(julianday(s.created_at) - julianday(a.created_at)) * 86400 < 10
        OR abs(julianday(s.updated_at) - julianday(a.created_at)) * 86400 < 10);
  UPDATE attachments SET segment_id = NULL;
  `,
];
