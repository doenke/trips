import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, rawMail, seg, type TestApp } from './helpers.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

/** A multipart body like the browser sends for dropped files. */
function multipart(files: { name: string; data: Buffer; type?: string }[], fields: Record<string, string> = {}) {
  const boundary = '----trips-test-boundary';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: ${f.type ?? 'application/octet-stream'}\r\n\r\n`,
      ),
    );
    parts.push(f.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

let t: TestApp;
let anna: Awaited<ReturnType<TestApp['login']>>;

const booking = {
  is_booking: true,
  trip_title: 'Rom im Frühling',
  destination: 'Rom',
  passengers: [],
  segments: [
    seg({ type: 'flight' as const, number: 'AZ 401', from_code: 'DUS', to_code: 'FCO', start_local: '2027-04-02T09:00', end_local: '2027-04-02T11:10' }),
  ],
};

beforeAll(async () => {
  t = await createTestApp();
  anna = await t.login('Anna');
  t.setExtraction(booking);
});
afterAll(async () => t?.close());

describe('mails dropped into the app', () => {
  it('reads an Outlook .msg with an attached mail and its PDFs into a trip', async () => {
    const trip = (await t.app.inject({ method: 'POST', url: '/api/trips', headers: anna.headers, payload: { title: 'Rom' } })).json();
    const body = multipart([{ name: 'Outer mail.msg', data: fixture('outer-mail.msg'), type: 'application/vnd.ms-outlook' }]);
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/trips/${trip.id}/import`,
      headers: { ...anna.headers, ...body.headers },
      payload: body.payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'imported', trip: { id: trip.id } });
    const sent = t.extractions.at(-1)!;
    expect(sent.subject).toBe('Outer mail');
    expect(sent.text).toContain('--- Angehängte Nachricht: Inner mail ---');
    expect(sent.pdfs.length).toBe(4);
    expect(res.json().attachments).toHaveLength(4);
    const full = (await t.app.inject({ method: 'GET', url: `/api/trips/${trip.id}`, headers: anna.headers })).json();
    expect(full.attachments).toHaveLength(4);
    // The same mail again: nothing attached twice, and the summary doesn't claim it.
    const again = await t.app.inject({
      method: 'POST',
      url: `/api/trips/${trip.id}/import`,
      headers: { ...anna.headers, ...body.headers },
      payload: body.payload,
    });
    expect(again.json().attachments).toEqual([]);
    expect(again.json().summary).not.toContain('Angehängt');
  });

  it('reads a .msg that carries an .eml as attachment', async () => {
    const body = multipart([{ name: 'weitergeleitet.msg', data: fixture('attached-eml.msg') }]);
    const res = await t.app.inject({ method: 'POST', url: '/api/import', headers: { ...anna.headers, ...body.headers }, payload: body.payload });
    expect(res.statusCode).toBe(200);
    expect(t.extractions.at(-1)!.text).toContain('--- Angehängte Nachricht: sample');
  });

  it('sorts a dropped .eml into the matching trip on the start page', async () => {
    const eml = rawMail({
      from: 'airline@example.org',
      subject: 'Ihre Buchung AZ 401',
      text: 'Flug AZ 401 Düsseldorf – Rom am 2. April 2027',
      messageId: 'drop-1@example.org',
      pdf: Buffer.from('%PDF-1.4\n%x\n'),
    });
    const body = multipart([{ name: 'Ihre Buchung.eml', data: Buffer.from(eml), type: 'message/rfc822' }]);
    const res = await t.app.inject({ method: 'POST', url: '/api/import', headers: { ...anna.headers, ...body.headers }, payload: body.payload });
    expect(res.statusCode).toBe(200);
    // The flight is already in "Rom" (first test) – it gets updated there, not duplicated.
    expect(res.json()).toMatchObject({ status: 'imported', trip: { title: 'Rom' } });
    expect(res.json().updated).toHaveLength(1);
    expect(t.extractions.at(-1)!).toMatchObject({ subject: 'Ihre Buchung AZ 401', pdfs: [expect.objectContaining({ filename: 'Buchung.pdf' })] });
  });

  it('explains files it cannot read', async () => {
    const body = multipart([{ name: 'urlaub.docx', data: Buffer.from('PK\u0003\u0004 not a mail') }]);
    const res = await t.app.inject({ method: 'POST', url: '/api/import', headers: { ...anna.headers, ...body.headers }, payload: body.payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('.eml oder .msg');
  });
});
