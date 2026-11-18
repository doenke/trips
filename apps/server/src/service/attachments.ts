import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  }

  path(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Anhang');
    return join(this.dir, id);
  }

  add(actor: Actor, tripId: string, file: { filename: string; data: Buffer; segmentId?: string | null }): AttachmentRow {
    if (!this.trips.canEdit(actor, tripId)) throw forbidden();
    if (file.data.length > MAX_ATTACHMENT_BYTES) throw badRequest('Die Datei ist zu groß (höchstens 20 MB).');
    const mime = sniffMime(file.data);
    if (!mime || !ALLOWED.test(mime)) throw badRequest('Nur PDFs und Bilder können angehängt werden.');
    if (file.segmentId && !this.db.get('SELECT 1 FROM segments WHERE id = ? AND trip_id = ?', file.segmentId, tripId)) throw notFound('Segment');
    const sha = sha256hex(file.data);
    // The same file twice (a booking mail forwarded again) is kept once.
    const same = this.db.get<AttachmentRow>('SELECT * FROM attachments WHERE trip_id = ? AND sha256 = ?', tripId, sha);
    if (same) return same;
    const id = randomUUID();
    const filename = file.filename.replace(/[\\/\0\r\n]/g, '_').slice(0, 200) || 'Anhang';
    writeFileSync(this.path(id), file.data);
    this.db.run(
      'INSERT INTO attachments (id, trip_id, segment_id, filename, mime, size, sha256, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      tripId,
      file.segmentId ?? null,
      filename,
      mime,
      file.data.length,
      sha,
      actor.userId,
    );
    return this.db.get<AttachmentRow>('SELECT * FROM attachments WHERE id = ?', id)!;
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
