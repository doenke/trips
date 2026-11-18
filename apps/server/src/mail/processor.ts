import type { FastifyBaseLogger } from 'fastify';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import { sha256hex } from '../crypto.js';
import type { Db } from '../db/index.js';
import { type BookingDocument, type BookingService, type ImportResult, summarize } from '../service/booking.js';
import type { UserService } from '../service/users.js';
import type { Mailer } from './notify.js';

export interface MailLogRow {
  id: number;
  message_id: string;
  sender: string | null;
  subject: string | null;
  status: string;
  detail: string | null;
  trip_id: string | null;
  user_id: string | null;
  created_at: string;
}

export type ProcessStatus = 'imported' | 'nothing_to_do' | 'no_booking' | 'ignored' | 'rejected' | 'duplicate' | 'error';

/** Very small HTML → text for mails without a text part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d|table)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

function firstAddress(a: AddressObject | AddressObject[] | undefined): string | null {
  const list = Array.isArray(a) ? a : a ? [a] : [];
  for (const o of list) for (const v of o.value) if (v.address) return v.address.toLowerCase();
  return null;
}

/** DMARC verdict of the receiving mail server ("Authentication-Results: …; dmarc=pass …"). */
export function dmarcResult(mail: ParsedMail): 'pass' | 'fail' | 'none' {
  const raw = mail.headers.get('authentication-results');
  const values = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String).join('\n').toLowerCase();
  if (/\bdmarc=fail\b/.test(values)) return 'fail';
  if (/\bdmarc=pass\b/.test(values)) return 'pass';
  return 'none';
}

/** Text and PDFs of a mail, including mails attached as message/rfc822 (forwarded "as attachment"). */
export async function collect(mail: ParsedMail, depth = 0): Promise<BookingDocument> {
  const text = mail.text?.trim() || (mail.html ? htmlToText(mail.html) : '');
  const doc: BookingDocument = { text, subject: mail.subject ?? null, pdfs: [] };
  for (const a of mail.attachments) {
    if (a.contentType === 'application/pdf' || /\.pdf$/i.test(a.filename ?? '')) {
      doc.pdfs.push({ filename: a.filename ?? 'Buchung.pdf', data: a.content });
    } else if (a.contentType === 'message/rfc822' && depth < 2) {
      const inner = await collect(await simpleParser(a.content), depth + 1);
      doc.text += `\n\n--- Weitergeleitete Nachricht: ${inner.subject ?? ''} ---\n${inner.text}`;
      doc.pdfs.push(...inner.pdfs);
    }
  }
  return doc;
}

/**
 * Handles one incoming mail end to end. Never throws: a broken mail must not stop the poller.
 * The Message-ID is claimed first (UNIQUE in mail_log), so a second container or a restart
 * never processes the same mail twice.
 */
export class MailProcessor {
  constructor(
    private readonly db: Db,
    private readonly users: UserService,
    private readonly booking: BookingService,
    private readonly mailer: Mailer | null,
    private readonly log: FastifyBaseLogger,
    private readonly opts: { requireDmarcPass: boolean; publicUrl: string },
  ) {}

  async process(source: Buffer | string): Promise<ProcessStatus> {
    let mail: ParsedMail;
    try {
      mail = await simpleParser(source);
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'Mail nicht lesbar');
      return 'error';
    }
    return this.processParsed(mail, typeof source === 'string' ? source : source.toString('latin1'));
  }

  async processParsed(mail: ParsedMail, raw = ''): Promise<ProcessStatus> {
    const messageId = mail.messageId?.trim() || `sha256:${sha256hex(raw || `${mail.subject}${mail.date?.toISOString()}${mail.text}`)}`;
    const sender = firstAddress(mail.from);
    const subject = mail.subject?.slice(0, 300) ?? null;

    try {
      this.db.run('INSERT INTO mail_log (message_id, sender, subject, status) VALUES (?, ?, ?, ?)', messageId, sender, subject, 'processing');
    } catch {
      // Already known. Retried are mails that failed (e.g. Claude was unreachable – move them back into
      // the import folder) and runs that died mid-way (still "processing" after 15 minutes).
      const reclaimed = this.db.run(
        `UPDATE mail_log SET status = 'processing', detail = NULL, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE message_id = ? AND (status = 'error' OR (status = 'processing' AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes')))`,
        messageId,
      );
      if (!reclaimed.changes) return 'duplicate';
    }
    const finish = (status: ProcessStatus, detail: string | null, tripId: string | null = null, userId: string | null = null) => {
      this.db.run('UPDATE mail_log SET status = ?, detail = ?, trip_id = ?, user_id = ? WHERE message_id = ?', status, detail, tripId, userId, messageId);
      return status;
    };

    // Auto-replies, vacation notices, our own summaries: never answer them (no mail loops).
    const auto = String(mail.headers.get('auto-submitted') ?? 'no').toLowerCase();
    if (auto !== 'no') return finish('ignored', `Automatische Mail (Auto-Submitted: ${auto}) – nicht verarbeitet.`);

    if (this.opts.requireDmarcPass && dmarcResult(mail) === 'fail') {
      this.log.warn({ sender }, 'Mail abgelehnt: DMARC fehlgeschlagen (Absender vermutlich gefälscht)');
      return finish('rejected', 'DMARC-Prüfung fehlgeschlagen – Absender vermutlich gefälscht');
    }
    const owner = sender ? this.users.ownerOfEmail(sender) : undefined;
    if (!owner) {
      this.log.info({ sender }, 'Mail von unbekanntem Absender ignoriert');
      return finish('ignored', `Unbekannter Absender ${sender ?? '(ohne Adresse)'} – nur Adressen von Konten (Login- oder Zusatzadresse) werden verarbeitet.`);
    }
    const actor = { userId: owner.id, isAdmin: !!owner.is_admin };

    let result: ImportResult;
    try {
      const doc = await collect(mail);
      result = await this.booking.importDocument(actor, doc, { source: 'mail' });
    } catch (err) {
      const message = (err as Error).message;
      this.log.warn({ err: message, sender }, 'Mail-Import fehlgeschlagen');
      await this.reply(
        mail,
        sender!,
        'Trips: Buchung konnte nicht übernommen werden',
        `Beim Übernehmen deiner Mail „${subject ?? ''}“ ist etwas schiefgegangen:\n\n${message}\n\nDu kannst die Buchung in der App auch mit „Buchung einfügen“ übernehmen.\n${this.opts.publicUrl}`,
      );
      return finish('error', message, null, owner.id);
    }

    const summary = summarize(result);
    const status: ProcessStatus = result.status;
    const counts = [
      result.created.length && `${result.created.length} neu`,
      result.updated.length && `${result.updated.length} aktualisiert`,
      result.deleted.length && `${result.deleted.length} gelöscht`,
    ]
      .filter(Boolean)
      .join(', ');
    const mailSubject =
      result.status === 'no_booking'
        ? 'Trips: keine Buchung erkannt'
        : `Trips: ${result.trip?.title ?? 'Buchung'}${counts ? ` – ${counts}` : ' – nichts geändert'}`;
    await this.reply(mail, sender!, mailSubject, `${summary}\n\n– Trips`);
    return finish(status, summary, result.trip?.id ?? null, owner.id);
  }

  private async reply(original: ParsedMail, to: string, subject: string, text: string): Promise<void> {
    if (!this.mailer) return;
    try {
      await this.mailer.send({ to, subject, text, inReplyTo: original.messageId ?? undefined });
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'Zusammenfassung nicht verschickt');
    }
  }

  recent(limit = 100): MailLogRow[] {
    return this.db.all<MailLogRow>('SELECT * FROM mail_log ORDER BY id DESC LIMIT ?', limit);
  }
}
