import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256hex } from '../crypto.js';
import type { Db } from '../db/index.js';
import { type Actor, badRequest, forbidden, notFound } from './errors.js';
import type { AttachmentRow, TripService } from './trips.js';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const ALLOWED = /^(application\/pdf|image\/(png|jpeg|gif|webp|heic|heif))$/;

/** Detects the real type from the first bytes – the client's word is not enough. */
export function sniffMime(data: Buffer): string | null {
  if (data.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (data[0] === 0x89 && data.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (data.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|mif1|heif)/.test(data.subarray(8, 12).toString('latin1'))) return 'image/heic';
  return null;
}

/** PDFs and pictures of a trip, as files under DATA_DIR/files. */
export class AttachmentService {
  private readonly dir: string;

  constructor(
    private readonly db: Db,
    private readonly trips: TripService,
    dataDir: string,
  ) {
    this.dir = join(dataDir, 'files');
    mkdirSync(this.dir, { recursive: true });
    trips.copyAttachment = (a, tripId) => this.copyTo(a, tripId);
  }

  /** A copy of a file for another trip (moving one of several segments that share it). */
  private copyTo(a: AttachmentRow, tripId: string): string {
    const same = this.db.get<{ id: string }>('SELECT id FROM attachments WHERE trip_id = ? AND sha256 = ?', tripId, a.sha256);
    if (same) return same.id;
    const id = randomUUID();
    copyFileSync(this.path(a.id), this.path(id));
    this.db.run(
      'INSERT INTO attachments (id, trip_id, filename, mime, size, sha256, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      tripId,
      a.filename,
      a.mime,
      a.size,
      a.sha256,
      a.created_by,
      a.created_at,
    );
    return id;
  }

  /** Links an attachment to segments of its trip (in addition to existing links). */
  private link(attachmentId: string, tripId: string, segmentIds: string[]): void {
    for (const segmentId of new Set(segmentIds)) {
      if (!this.db.get('SELECT 1 FROM segments WHERE id = ? AND trip_id = ?', segmentId, tripId)) throw notFound('Segment');
      this.db.run('INSERT OR IGNORE INTO attachment_segments (attachment_id, segment_id) VALUES (?, ?)', attachmentId, segmentId);
    }
  }

  path(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Anhang');
    return join(this.dir, id);
  }

  /** Stores a PDF or picture in a trip; with segmentIds it belongs to those segments, without to the whole trip. */
  add(actor: Actor, tripId: string, file: { filename: string; data: Buffer; segmentIds?: string[] }): AttachmentRow {
    if (!this.trips.canEdit(actor, tripId)) throw forbidden();
    if (file.data.length > MAX_ATTACHMENT_BYTES) throw badRequest('Die Datei ist zu groß (höchstens 20 MB).');
    const mime = sniffMime(file.data);
    if (!mime || !ALLOWED.test(mime)) throw badRequest('Nur PDFs und Bilder können angehängt werden.');
    const segmentIds = file.segmentIds ?? [];
    for (const segmentId of segmentIds) if (!this.db.get('SELECT 1 FROM segments WHERE id = ? AND trip_id = ?', segmentId, tripId)) throw notFound('Segment');
    const sha = sha256hex(file.data);
    // The same file twice (a booking mail forwarded again) is kept once – and also linked to the new segments.
    const same = this.db.get<AttachmentRow>('SELECT * FROM attachments WHERE trip_id = ? AND sha256 = ?', tripId, sha);
    if (same) {
      this.link(same.id, tripId, segmentIds);
      return same;
    }
    const id = randomUUID();
    const filename = file.filename.replace(/[\\/\0\r\n]/g, '_').slice(0, 200) || 'Anhang';
    writeFileSync(this.path(id), file.data);
    this.db.run(
      'INSERT INTO attachments (id, trip_id, filename, mime, size, sha256, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      tripId,
      filename,
      mime,
      file.data.length,
      sha,
      actor.userId,
    );
    this.link(id, tripId, segmentIds);
    return this.db.get<AttachmentRow>('SELECT * FROM attachments WHERE id = ?', id)!;
  }

  segmentIds(attachmentId: string): string[] {
    return this.db.all<{ segment_id: string }>('SELECT segment_id FROM attachment_segments WHERE attachment_id = ?', attachmentId).map((r) => r.segment_id);
  }

  /** Is exactly this file already attached to the trip? */
  has(tripId: string, data: Buffer): boolean {
    return !!this.db.get('SELECT 1 FROM attachments WHERE trip_id = ? AND sha256 = ?', tripId, sha256hex(data));
  }

  /** Every signed-in user may read. */
  get(id: string): AttachmentRow {
    const a = this.db.get<AttachmentRow>('SELECT * FROM attachments WHERE id = ?', id);
    if (!a) throw notFound('Anhang');
    return a;
  }

  delete(actor: Actor, id: string): void {
    const a = this.get(id);
    if (!this.trips.canEdit(actor, a.trip_id)) throw forbidden();
    this.db.run('DELETE FROM attachments WHERE id = ?', id);
    this.removeFiles([id]);
  }

  removeFiles(ids: string[]): void {
    for (const id of ids) rmSync(this.path(id), { force: true });
  }
}
