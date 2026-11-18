import MsgReaderModule from '@kenjiuno/msgreader';
import { simpleParser } from 'mailparser';
import type { BookingDocument } from '../service/booking.js';
import { badRequest } from '../service/errors.js';
import { collect, htmlToText } from './processor.js';

/** The package is CommonJS with a default export; depending on the loader it arrives wrapped. */
type Reader = { getFileData(): MsgFields; getAttachment(a: MsgFields): { fileName?: string; content: Uint8Array } };
type MsgFields = {
  subject?: string;
  body?: string;
  bodyHtml?: string;
  html?: Uint8Array;
  senderName?: string;
  senderEmail?: string;
  fileName?: string;
  fileNameShort?: string;
  attachMimeTag?: string;
  innerMsgContent?: true;
  attachments?: MsgFields[];
};
const MsgReader = ((MsgReaderModule as unknown as { default?: unknown }).default ?? MsgReaderModule) as new (b: ArrayBuffer) => Reader;

const isPdf = (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-';
/** Outlook .msg files are OLE compound documents. */
const isMsg = (b: Buffer) => b.length > 8 && b.readUInt32BE(0) === 0xd0cf11e0 && b.readUInt32BE(4) === 0xa1b11ae1;
/** An .eml: plain text that starts with mail headers. */
const isEml = (name: string, b: Buffer) =>
  /\.eml$/i.test(name) ||
  (/^(?:[A-Za-z-]+:[^\n]*\r?\n)+/.test(b.subarray(0, 2000).toString('latin1')) &&
    /\n(from|subject|date|received):/i.test(`\n${b.subarray(0, 8000).toString('latin1')}`));

/** Reads an Outlook .msg: text (or HTML as text), PDF attachments and attached mails, recursively. */
export async function documentFromMsg(data: Buffer, depth = 0): Promise<BookingDocument> {
  const reader = new MsgReader(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  const msg = reader.getFileData();
  const html = msg.bodyHtml ?? (msg.html ? Buffer.from(msg.html).toString('utf8') : '');
  const doc: BookingDocument = { text: msg.body?.trim() || (html ? htmlToText(html) : ''), subject: msg.subject ?? null, pdfs: [] };
  if (msg.senderEmail || msg.senderName)
    doc.text = `Von: ${[msg.senderName, msg.senderEmail && `<${msg.senderEmail}>`].filter(Boolean).join(' ')}\n\n${doc.text}`;
  for (const a of msg.attachments ?? []) {
    let file: { fileName?: string; content: Uint8Array };
    try {
      file = reader.getAttachment(a);
    } catch {
      continue;
    }
    const name = file.fileName || a.fileName || a.fileNameShort || 'Anhang';
    const content = Buffer.from(file.content);
    if (isPdf(content)) doc.pdfs.push({ filename: name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`, data: content });
    else if (depth < 2 && (a.innerMsgContent || isMsg(content))) {
      const inner = await documentFromMsg(content, depth + 1);
      doc.text += `\n\n--- Angehängte Nachricht: ${inner.subject ?? ''} ---\n${inner.text}`;
      doc.pdfs.push(...inner.pdfs);
    } else if (depth < 2 && (a.attachMimeTag === 'message/rfc822' || /\.eml$/i.test(name))) {
      const inner = await collect(await simpleParser(content), depth + 1);
      doc.text += `\n\n--- Angehängte Nachricht: ${inner.subject ?? ''} ---\n${inner.text}`;
      doc.pdfs.push(...inner.pdfs);
    }
  }
  return doc;
}

/**
 * Files dropped into the app or picked in "Buchung einfügen": PDFs, mails as .eml (Outlook for Mac,
 * Thunderbird, Apple Mail) and Outlook's .msg (classic Outlook on Windows). All of them together
 * become one booking document.
 */
export async function documentFromFiles(files: { filename: string; data: Buffer }[], text = ''): Promise<BookingDocument> {
  const doc: BookingDocument = { text, subject: null, pdfs: [] };
  const add = (d: BookingDocument) => {
    doc.subject ??= d.subject ?? null;
    if (d.text.trim()) doc.text += `${doc.text ? '\n\n' : ''}${d.subject ? `Betreff: ${d.subject}\n` : ''}${d.text}`;
    doc.pdfs.push(...d.pdfs);
  };
  for (const f of files) {
    if (isPdf(f.data)) doc.pdfs.push(f);
    else if (isMsg(f.data)) {
      try {
        add(await documentFromMsg(f.data));
      } catch {
        throw badRequest(`„${f.filename}“ ließ sich nicht als Outlook-Nachricht lesen.`);
      }
    } else if (isEml(f.filename, f.data)) add(await collect(await simpleParser(f.data)));
    else throw badRequest(`„${f.filename}“: Bitte eine E-Mail (.eml oder .msg aus Outlook) oder ein PDF verwenden.`);
  }
  return doc;
}
