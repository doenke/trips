export type SegmentType = 'flight' | 'train' | 'hotel' | 'car' | 'parking' | 'other';

export interface User {
  id: string;
  name: string;
  email: string | null;
  avatar: string | null;
  is_admin: boolean;
}

export interface Segment {
  id: string;
  trip_id: string;
  type: SegmentType;
  title: string;
  start_local: string | null;
  start_tz: string | null;
  end_local: string | null;
  end_tz: string | null;
  from_name: string | null;
  from_code: string | null;
  to_name: string | null;
  to_code: string | null;
  carrier: string | null;
  number: string | null;
  booking_ref: string | null;
  seat: string | null;
  address: string | null;
  notes: string | null;
  source: 'manual' | 'mail' | 'mcp' | 'import';
  start_utc: string | null;
  end_utc: string | null;
  airtrail: { users: string[]; error: string | null };
}

export interface Attachment {
  id: string;
  /** The entries the file belongs to; empty = the whole trip. */
  segment_ids: string[];
  filename: string;
  mime: string;
  size: number;
  url: string;
  created_at: string;
}

export interface TripBase {
  id: string;
  title: string;
  destination: string | null;
  start_date: string | null;
  end_date: string | null;
  notes: string | null;
  travelers: User[];
  can_edit: boolean;
  updated_at: string;
}

export interface TripSummary extends TripBase {
  segment_count: number;
  next_segment: Segment | null;
}

export interface Trip extends TripBase {
  segments: Segment[];
  attachments: Attachment[];
}

export interface Me {
  user: User;
  via: 'session' | 'token';
  alt_emails: string[];
  airtrail: { enabled: boolean; url: string | null; connected: boolean; status: string | null };
  ics_url: string;
  import_address: string | null;
  mcp_url: string;
  extraction: boolean;
  version: string;
  provider: string;
}

export interface AuthConfig {
  oidc: boolean;
  provider: string;
  devLogin: boolean;
  redirectUri: string;
}

export interface ImportResult {
  status: 'imported' | 'no_booking' | 'nothing_to_do';
  trip: { id: string; title: string; url: string } | null;
  trip_created: boolean;
  created: string[];
  updated: string[];
  deleted: string[];
  not_found: string[];
  travelers_added: string[];
  attachments: string[];
  summary: string;
}

export interface TokenInfo {
  id: string;
  kind: 'pat' | 'oauth';
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
}

export type SegmentInput = Omit<Segment, 'id' | 'trip_id' | 'source' | 'start_utc' | 'end_utc' | 'airtrail'>;
