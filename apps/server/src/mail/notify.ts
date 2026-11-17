import nodemailer from 'nodemailer';
import type { Config } from '../config.js';

export interface Mailer {
  send(m: { to: string; subject: string; text: string; inReplyTo?: string }): Promise<void>;
}

/** SMTP for summary mails; null when SMTP is not configured (then nothing is sent). */
export function createMailer(config: Config): Mailer | null {
  if (!config.SMTP_HOST) return null;
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD ?? '' } : undefined,
  });
  const from = config.SMTP_FROM ?? config.SMTP_USER ?? config.IMPORT_ADDRESS;
  return {
    async send(m) {
      await transport.sendMail({
        from,
        to: m.to,
        subject: m.subject,
        text: m.text,
        ...(m.inReplyTo ? { inReplyTo: m.inReplyTo, references: m.inReplyTo } : {}),
        headers: { 'Auto-Submitted': 'auto-replied' },
      });
    },
  };
}
